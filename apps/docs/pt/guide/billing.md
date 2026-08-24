# Subscrições

`@basaltkit/subscriptions` modela a faturação na tua própria base de dados, com
as gateways de pagamento como drivers. A tua app fala com o Basalt; só os drivers
falam com o Stripe, Paddle, Lemon Squeezy — ou, para Angola, ProxyPay/Multicaixa.
As verificações de funcionalidades e as quotas leem estado local, por isso são
instantâneas e nunca chamam a gateway.

[[toc]]

## Definir planos

Um plano é um preço mais um conjunto de funcionalidades. `definePlans` preserva os
tipos exatos, para que `subscriptions.features(...)` e os route guards conheçam os
nomes das tuas funcionalidades. `meter(n)` embrulha um número numa quota que se
reinicia mensalmente.

```ts
// src/billing/plans.ts
import { definePlans, meter } from '@basaltkit/subscriptions'

export const plans = definePlans({
  free: {
    price: 0, // 0 = gratuito, nunca toca na gateway
    features: { projects: 3, api: false },
  },
  pro: {
    price: { monthly: 29, yearly: 290 }, // preço por período
    trial: '14d',                        // trial de 14 dias → status 'trialing'
    features: {
      projects: 50,                 // saldo vitalício
      api: true,                    // flag on/off
      'api.requests': meter(100_000), // quota que se reinicia a cada mês de calendário
    },
  },
  scale: {
    price: 'custom', // "fala com o comercial" — sem checkout self-serve
    features: { projects: Number.POSITIVE_INFINITY, api: true },
  },
})
```

Os valores das funcionalidades falam por si:

| Valor | Significado |
| --- | --- |
| `boolean` | Flag on/off (`can(feature)`) |
| `number` | Saldo consumível vitalício — nunca se reinicia |
| `meter(n)` | Quota que se reinicia a cada mês de calendário (bucket `YYYY-MM`) |
| `Infinity` | Ilimitado |

`price` é `0` (gratuito), um único `number` (igual em ambos os períodos), um
objeto `{ monthly, yearly }`, ou `'custom'` (liderado pelo comercial — o checkout
fica desativado).

### Persistir o catálogo de planos

Os planos são consumidos de forma **síncrona** (pelo `planPrice`, features e
guards), por isso mantém a fonte de verdade num `PlanStore` e **carrega-o uma vez
no arranque**:

```ts
import { loadPlans, subscriptionsPlugin } from '@basaltkit/subscriptions'

const plans = await loadPlans(planStore) // lê a tua BD, constrói o objeto Plans
subscriptionsPlugin({ plans, fallbackPlan: 'free', ...stores })
```

O `MemoryPlanStore` (semeia-o com um objeto `definePlans`) serve para testes;
suporta um `PlanStore` real com a tua base de dados para gerir planos na BD — as
edições aplicam-se no restart. O `plansToStored(plans)` transforma um objeto
`definePlans` em linhas para o seed.

## Ligar o plugin

`subscriptionsPlugin` regista o serviço sob o token `SUBSCRIPTIONS` e instala os
route guards `meta.subscribed` / `meta.feature`. As suas opções são as mesmas de
`new Subscriptions(...)` menos `hooks` (o plugin passa o `HookBus` da app
automaticamente).

```ts
// src/billing/subscriptions.ts
import { Subscriptions } from '@basaltkit/subscriptions'
import { plans } from './plans.js'

// Serviço standalone (sem HTTP, sem gateway) — tudo funciona localmente.
export const subscriptions = new Subscriptions({
  plans,
  fallbackPlan: 'free', // aplicado a quem não tem subscrição
})
```

| Opção | Tipo | Predefinição | Finalidade |
| --- | --- | --- | --- |
| `plans` | `Plans` | — | O teu catálogo de planos (obrigatório) |
| `fallbackPlan` | `string` | — | Plano para quem não tem subscrição |
| `gateway` | `BillingGateway` | — | Driver Stripe/Paddle para subscrições com cartão |
| `store` | `SubscriptionStore` | em memória | Onde as subscrições são persistidas |
| `usage` | `UsageStore` | em memória | Contadores de medição (`consume` atómico) |
| `webhooks` | `WebhookStore` | em memória | Deduplicação de webhooks por id de evento |

## Subscrever e gerir

O faturável é o tenant por convenção — `'acme'` abaixo é um id de tenant.

```ts
await subscriptions.subscribe('acme', 'pro')                       // mensal (predefinição)
await subscriptions.subscribe('acme', 'pro', { period: 'yearly' }) // anual

await subscriptions.swap('acme', 'scale')                    // muda de plano, com proração
await subscriptions.swap('acme', 'scale', { prorate: false }) // muda apenas na próxima renovação

await subscriptions.cancel('acme')                         // no fim do período (fica ativo até lá)
await subscriptions.cancel('acme', { atPeriodEnd: false })  // imediato → status 'canceled'
await subscriptions.resume('acme')                          // desfaz um cancelamento agendado

await subscriptions.subscribed('acme')        // true se ativo ou num trial válido
await subscriptions.subscribed('acme', 'pro') // ...num plano específico
await subscriptions.onTrial('acme')           // boolean
await subscriptions.get('acme')               // SubscriptionRecord | null
```

Um `SubscriptionRecord` é `{ billableId, plan, period, status, trialEndsAt?,
cancelAtPeriodEnd?, canceledAt?, gatewayRef? }` onde `status` é um de
`active`, `trialing`, `past_due`, `canceled`, `incomplete`.

## Limites de funcionalidades e medição

`features(billableId)` devolve a API de aplicação. Lê apenas estado local, por
isso é instantânea e segura de chamar em cada pedido.

```ts
const features = subscriptions.features('acme')

await features.can('api')            // true no pro
await features.limit('projects')     // 50 (false→0, true→Infinity)
await features.usage('projects')     // consumido até agora neste período
await features.remaining('projects') // limite − uso

// Regista o consumo de forma atómica — seguro sob concorrência.
await features.consume('projects', 2)      // cria 2 projetos
await features.consume('api.requests', 1)  // medido; reinicia-se mensalmente
```

`consume` lança `QuotaExceededError` (`BILLING_QUOTA_EXCEEDED`, 402) quando o
limite se esgota, e `FeatureUnavailableError` (`BILLING_FEATURE_UNAVAILABLE`,
403) quando o plano não concede a funcionalidade de todo. Captura estes erros
para mostrar um convite ao upgrade:

```ts
import { QuotaExceededError, FeatureUnavailableError } from '@basaltkit/subscriptions'

try {
  await features.consume('api.requests', 1)
} catch (err) {
  if (err instanceof QuotaExceededError) return reply.code(402).send({ upgrade: true })
  if (err instanceof FeatureUnavailableError) return reply.code(403).send({ upgrade: true })
  throw err
}
```

::: tip Medidores vs. saldos
`meter(n)` reinicia-se a cada mês de calendário; um `number` simples é um saldo
vitalício que nunca se reinicia. Escolhe o tipo de número deliberadamente — é a
diferença entre "1000 chamadas de API por mês" e "1000 chamadas de API para
sempre".
:::

### Uso medido e preços por escalões

Cobra o consumo por escalões — `graduated` (cada unidade ao preço do escalão em
que cai) ou `volume` (todas as unidades ao escalão em que o total aterra) — e
transforma o uso registado numa linha de fatura:

```ts
import { meteredLine, tieredCost } from '@basaltkit/subscriptions'

const price = {
  mode: 'graduated' as const,
  tiers: [
    { upTo: 1000, unitAmount: 2 }, // primeiras 1.000 chamadas @ $0.02
    { upTo: null, unitAmount: 1 }, // acima @ $0.01
  ],
}

const line = meteredLine('api.calls', { units: 2_500, includedUnits: 1_000, price })
// → uma linha para as 1.500 unidades faturáveis; tieredCost(price, 1500) = 2500 (¢)

await invoices.draft({ billableId, currency: 'USD', lineItems: [line].filter(Boolean) })
```

O `includedUnits` (a franquia do plano) é subtraído primeiro; o `meteredLine`
devolve `null` quando nada é faturável. Usa o `tieredCost(price, units)`
diretamente para pré-visualizações ou rateio. Preços por escalões não têm uma taxa
única por unidade, por isso a linha é um valor único com o detalhe no `metadata`.

## Proteger rotas

Anexa requisitos como `meta` da rota. O guard resolve o faturável a partir do
tenant do pedido e rejeita antes de o teu handler correr.

```ts
import { route } from '@basaltkit/fastify'

route({ method: 'GET', url: '/reports', meta: { subscribed: 'pro' }, async handler() {
  return { ok: true }
}})

route({ method: 'GET', url: '/api/data', meta: { feature: 'api' }, async handler() {
  return { data: [] }
}})
```

`meta: { subscribed: true }` exige qualquer subscrição ativa;
`meta: { subscribed: 'pro' }` exige esse plano específico. Requisitos não
cumpridos devolvem `402 BILLING_SUBSCRIPTION_REQUIRED` ou
`403 BILLING_FEATURE_UNAVAILABLE`.

## Stripe: checkout, portal, webhook

O driver Stripe visa a API REST do Stripe diretamente (sem o SDK `stripe`) e
verifica as assinaturas dos webhooks com o crypto do Node. Diz-lhe como mapear
planos para Price IDs do Stripe e como resolver o Customer ID do Stripe de cada
tenant.

```ts
// src/billing/gateway.ts
import { StripeBillingGateway } from '@basaltkit/subscriptions'

const PRICE_IDS = {
  pro: { monthly: 'price_pro_m', yearly: 'price_pro_y' },
} as const

export const gateway = new StripeBillingGateway({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!, // whsec_...
  priceId: (plan, period) => PRICE_IDS[plan as 'pro'][period],
  customerId: (tenantId) => getOrCreateStripeCustomer(tenantId),
})
```

Liga a gateway ao plugin e regista as rotas de faturação prontas a usar.
`billingRoutes` dá-te o **Checkout** alojado e o **Portal** self-service;
`billingWebhookRoute` dá-te o endpoint que o Stripe chama de volta.

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, route } from '@basaltkit/fastify'
import {
  billingRoutes,
  billingWebhookRoute,
  subscriptionsPlugin,
} from '@basaltkit/subscriptions'
import { plans } from './billing/plans.js'
import { gateway } from './billing/gateway.js'

const app = await createApp({
  plugins: [
    // ... o teu plugin de tenancy, que define context.tenant ...
    subscriptionsPlugin({ plans, fallbackPlan: 'free', gateway }),
    fastifyPlugin({
      routes: [
        ...billingRoutes({
          successUrl: 'https://app.example.com/thank-you',
          cancelUrl: 'https://app.example.com/pricing',
          // portalReturnUrl: 'https://app.example.com/account',
        }),
        billingWebhookRoute(gateway),
      ],
    }),
  ],
}).boot()
```

Rotas registadas:

| Rota | Corpo | Devolve |
| --- | --- | --- |
| `POST /billing/checkout` | `{ plan, period?, successUrl?, cancelUrl? }` | `{ url }` — redireciona o cliente para aqui |
| `POST /billing/portal` | `{ returnUrl? }` (opcional) | `{ url }` |
| `POST /billing/webhook` | payload bruto da gateway | `{ received, duplicate }` |

O ciclo de vida: o Checkout cria uma subscrição `incomplete` e devolve um URL; o
cliente paga na página alojada do Stripe; o webhook `payment.succeeded` passa-a
para `active`. O processamento de webhooks é idempotente por id de evento — uma
entrega duplicada devolve `{ duplicate: true }` e não altera nada.

Preferes conduzir tu mesmo em vez de usar as rotas? Os métodos do serviço são
públicos:

```ts
const { url } = await subscriptions.checkout('acme', 'pro', {
  successUrl: 'https://app.example.com/thank-you',
  cancelUrl: 'https://app.example.com/pricing',
})
const portal = await subscriptions.portal('acme', { returnUrl: 'https://app.example.com/account' })
```

::: warning Aviso: corpo bruto obrigatório
O Stripe verifica a assinatura contra os bytes **intactos** do pedido. Configura
um parser de corpo bruto para a rota do webhook, para que o handler receba a
string original — re-serializar um objeto já parseado quebra o HMAC. Um 400
`BILLING_WEBHOOK_INVALID` que não desaparece é quase sempre isto.
:::

Para desenvolvimento e testes há o `FakeBillingGateway`, que regista cada chamada
em arrays (`created`, `canceled`, `checkouts`, `portals`, `swaps`) e aceita a
assinatura de webhook `'valid'`.

## Faturas

Uma subscrição diz *a que* um tenant tem direito; uma **fatura** é o registo *do
que lhe foi cobrado* num período — line items, desconto, imposto, totais e um
estado de pagamento. O motor é domínio puro (sem HTTP, sem gateway), por isso
comporta-se da mesma forma por trás de qualquer adaptador ou driver de pagamento.

O ciclo de vida é `draft → open → paid`, e uma fatura em `draft` ou `open` pode
ser anulada (`void`). **Todos os valores são inteiros em unidades menores**
(cêntimos), coerente com o resto do billing.

```ts
import { Invoices, planLine, overageLine } from '@basaltkit/subscriptions'

const invoices = new Invoices({ taxRate: 0.14 }) // 14% de IVA por omissão

// Constrói a partir do plano + qualquer excedente medido no período
const draft = await invoices.draft({
  billableId: tenantId,
  currency: 'USD',
  lineItems: [
    planLine('pro', plans.pro, 'monthly'),                       // base de $29.00
    overageLine('api.calls', { used: 1500, included: 1000, unitAmount: 2 })!, // 500 × $0.02
  ],
  discount: 500,        // $5.00 de desconto, aplicado antes do imposto
})

const open = await invoices.finalize(draft.id) // atribui INV-2026-0001, estado → open
await invoices.markPaid(open.id, { paymentId: 'pay_123' }) // quando o gateway confirmar
```

`overageLine()` devolve `null` quando o uso está dentro da franquia (espalha e
filtra, ou usa-o só quando há excedente). `planLine()` lança para um preço
`'custom'` (sales-led) — esses não têm valor self-serve.

### Cupões e descontos

Define um cupão — `percentOff` (0–100) ou um `amountOff` fixo (unidades menores +
moeda), com `maxRedemptions` e expiração `redeemBy` opcionais — e depois aplica-o
ao criar uma fatura:

```ts
import { Coupons } from '@basaltkit/subscriptions'

const coupons = new Coupons()
await coupons.define({ code: 'LAUNCH20', percentOff: 20, maxRedemptions: 100 })

// valida + calcula (lança se desconhecido, expirado, esgotado, ou moeda errada)
const { discount } = await coupons.quote('LAUNCH20', subtotalMinor, 'USD')

const invoice = await invoices.draft({
  billableId: tenantId,
  currency: 'USD',
  lineItems: [planLine('pro', plans.pro, 'monthly')],
  coupon: { code: 'LAUNCH20', percentOff: 20 }, // somado a qualquer desconto explícito
})
// → invoice.discount reflete o cupão; invoice.couponCode = 'LAUNCH20'

await coupons.redeem('LAUNCH20') // quando o pagamento tem sucesso, consome uma redenção
```

O `quote()` valida a redimibilidade **sem** consumir; o `redeem()` incrementa o
contador. Um cupão de valor fixo só se aplica a faturas na sua própria moeda.
Em produção, suporta o registo com um `CouponStore` durável (o padrão é em memória).

### Liquidar a partir de um webhook de pagamento

As faturas não falam com os gateways. Quando o teu pagamento confirma (via
`handleWebhook` ou o evento `confirmed` do `PaymentLedger`), chama `markPaid`:

```ts
ledger.on('confirmed', async ({ record }) => {
  if (record?.reference) await invoices.markPaid(record.reference, { paymentId: record.id })
})
```

### Expor faturas por HTTP

`invoiceRoutes()` adiciona endpoints só-de-leitura, com âmbito de tenant,
construídos sobre o `route()` neutro — por isso servem de forma idêntica em
**Fastify, Express e Hono**:

```ts
import { subscriptionsPlugin, invoiceRoutes } from '@basaltkit/subscriptions'

createApp({
  plugins: [
    subscriptionsPlugin({ plans, fallbackPlan: 'free', gateway, invoices: { taxRate: 0.14 } }),
    fastifyPlugin({ routes: [...invoiceRoutes()] }), // ou expressPlugin / honoPlugin
  ],
})
```

| Rota | Devolve |
| --- | --- |
| `GET /billing/invoices` | `{ data: Invoice[] }` do tenant atual, mais recentes primeiro |
| `GET /billing/invoices/:id` | uma fatura em JSON (404 se não for do tenant) |
| `GET /billing/invoices/:id/html` | uma fatura em HTML imprimível |

Resolve o token `INVOICES` (ou a tua instância `Invoices`) para emitir e
finalizar faturas no servidor; as rotas são deliberadamente só-de-leitura. Em
produção, suporta o motor com um `InvoiceStore` durável — o padrão é em memória.

Renderiza em qualquer lado com `renderInvoiceText(invoice)` (recibos, emails) ou
`renderInvoiceHtml(invoice)` (autossuficiente, sem assets externos). Para **PDF**,
adiciona o [`@basaltkit/subscriptions-pdf`](https://www.npmjs.com/package/@basaltkit/subscriptions-pdf)
e chama `renderInvoicePdf(invoice, { businessName })` → um `Buffer` (mantém o pdfkit
fora do core sem dependências).

## Stores duráveis

As stores predefinidas são em memória e por processo — bom para um único nó ou um
teste, errado para produção, onde os contadores de uso têm de ser atómicos entre
processos. Dois pacotes drop-in fornecem stores duráveis.

### SQLite (`@basaltkit/subscriptions-sqlite`)

Suportado pelo `node:sqlite` incorporado do Node. `sqliteSubscriptionsStores`
abre (ou cria) a base de dados, aplica o schema e devolve as três stores com
nomes prontos a encaixar diretamente no plugin.

```ts
import { sqliteSubscriptionsStores } from '@basaltkit/subscriptions-sqlite'
import { subscriptionsPlugin } from '@basaltkit/subscriptions'
import { plans } from './billing/plans.js'

const s = sqliteSubscriptionsStores('./data/billing.db')

subscriptionsPlugin({
  plans,
  fallbackPlan: 'free',
  store: s.store,
  usage: s.usage,
  webhooks: s.webhooks,
})
```

### Prisma (`@basaltkit/subscriptions-prisma`)

Para PostgreSQL, MySQL e afins. Traz um `PrismaClient` cujo schema inclua os
modelos `Subscription`, `UsageCounter` e `WebhookEvent` (um
`prisma/schema.prisma` acompanha o pacote).

```ts
import { prismaSubscriptionsStores } from '@basaltkit/subscriptions-prisma'
import { subscriptionsPlugin } from '@basaltkit/subscriptions'
import { PrismaClient } from '@prisma/client'
import { plans } from './billing/plans.js'

const prisma = new PrismaClient()
const s = prismaSubscriptionsStores(prisma)

subscriptionsPlugin({ plans, fallbackPlan: 'free', ...s })
```

O `consume()` medido é atómico: um `updateMany` condicional incrementa apenas
enquanto `value <= limit - amount` se mantém, e o lock da linha serializa os
chamadores concorrentes — por isso uma quota nunca é ultrapassada.

::: tip Dica: alternativa com Redis
Se já corres Redis, `RedisUsageStore` e `RedisWebhookStore` (de
`@basaltkit/subscriptions`) dão as mesmas garantias: check-and-increment numa
única ida e volta `EVAL` (Lua), e deduplicação durável via `SET NX`.
:::

## Trials

Para um plano pago com `trial`, uma gateway configurada cria a subscrição com o
período de trial à partida e cobra no fim do trial, enviando o webhook que passa
`trialing → active` (ou `past_due` numa cobrança falhada).

Sem gateway, os trials são locais: corre `expireTrials()` a partir do scheduler
para os liquidar. Um plano gratuito gradua-se para `active`; um pago fica em
`past_due` (não há forma de cobrar). Os trials suportados por gateway são
deliberadamente deixados ao webhook da gateway — `expireTrials()` ignora-os.

```ts
// ex. de @basaltkit/scheduler
const settled = await subscriptions.expireTrials()
```

## Pagamentos angolanos / por referência (PaymentGateway)

::: tip Dica: guia completo
Isto é um resumo. Para a história completa — o modelo de dinheiro, o ledger
idempotente, os hooks de ciclo de vida, as stores duráveis Prisma/SQLite, o
hot-path de deduplicação com Redis, e a faturação recorrente — vê
**[Pagamentos por referência e mobile-money](/pt/guide/reference-payments)**.
:::

O `BillingGateway` do Stripe modela **subscrições com cartão em ficheiro**. Os
fornecedores angolanos funcionam de forma diferente: não há cartão guardado nem
portal self-service. O cliente paga uma **Referência** num ATM, no Multicaixa
Express, ou numa app de banco, usando a **Entidade** fixa da tua conta — e o
fornecedor confirma por webhook. O Basalt modela isto com um contrato separado,
`PaymentGateway`, cujo driver para o ProxyPay é enviado como
`@basaltkit/subscriptions-proxypay`.

```bash
pnpm add @basaltkit/subscriptions @basaltkit/subscriptions-proxypay
```

Uma `PaymentGateway` tem dois métodos: `createPayment(request)` reserva um
pagamento e devolve uma `PaymentInstruction` (o que mostrar ao cliente), e
`verifyWebhook(rawBody, signature)` traduz o callback do fornecedor num
`PaymentEvent` (`payment.succeeded` / `payment.failed`) ou `null` para eventos
sobre os quais não atuas.

### Construir a gateway

```ts
// src/billing/payments.ts
import { ProxyPayGateway } from '@basaltkit/subscriptions-proxypay'

export const payments = new ProxyPayGateway({
  apiKey: process.env.PROXYPAY_API_KEY!,        // enviado como `Authorization: Token <key>`
  entity: process.env.PROXYPAY_ENTITY!,         // a tua Entidade Multicaixa
  sandbox: process.env.NODE_ENV !== 'production', // api.sandbox.proxypay.co.ao
  webhookSecret: process.env.PROXYPAY_WEBHOOK_SECRET, // HMAC-SHA256, opcional
})
```

| Opção | Tipo | Finalidade |
| --- | --- | --- |
| `apiKey` | `string` | Enviado como `Authorization: Token <apiKey>` (obrigatório) |
| `entity` | `string` | A tua Entidade Multicaixa, atribuída pelo ProxyPay/EMIS (obrigatório) |
| `sandbox` | `boolean` | Usa o host de sandbox. Predefinição `false` (produção) |
| `baseUrl` | `string` | Substitui o URL base por completo |
| `webhookSecret` | `string` | Segredo partilhado para verificação de webhook HMAC-SHA256 |
| `fetch` | `FetchLike` | Fetch injetado; predefine para o `fetch` global |

### Criar um pagamento e mostrar a referência

`createPayment` reserva uma referência e devolve a entidade + referência para pôr
à frente do cliente. Os montantes são em AOA na unidade maior (`5000` =
5.000,00 Kz).

```ts
import { payments } from './billing/payments.js'

const instruction = await payments.createPayment({
  billableId: 'acme',              // ecoado de volta no webhook para reconciliação
  amount: 5000,                    // 5.000,00 Kz
  reference: 'invoice_2026_08',    // o teu id de encomenda/fatura
  expiresAt: Date.now() + 3 * 24 * 60 * 60 * 1000, // pagável durante 3 dias
})

// instruction.reference = { entity: '00123', reference: '900000001', amount: 5000 }
// Mostra: "Entidade 00123 · Referência 900000001 · 5.000,00 Kz"
```

Uma `PaymentInstruction` é `{ id, status: 'pending' | 'paid' | 'failed',
reference?, url?, push?, raw? }`. O ProxyPay é baseado em referências, por isso
preenche `reference` (`{ entity, reference, amount }`); fornecedores baseados em
redirect ou push preencheriam `url` ou `push` em vez disso.

### Receber o webhook

Aponta o webhook `payment` do ProxyPay para uma rota, passa o corpo **bruto** a
`verifyWebhook`, e atua sobre `payment.succeeded`. Esta é uma rota HTTP simples,
não `billingWebhookRoute` (essa é para drivers `BillingGateway` de cartão).

```ts
import { FASTIFY } from '@basaltkit/fastify'
import { payments } from './billing/payments.js'
import { subscriptions } from './billing/subscriptions.js'

const fastify = app.container.get(FASTIFY)

fastify.post('/webhooks/proxypay', async (request, reply) => {
  const raw = request.rawBody as string // bytes exatos — necessários para a assinatura
  const event = payments.verifyWebhook(raw, request.headers['x-signature'] as string | undefined)

  if (event?.type === 'payment.succeeded') {
    // event = { id, type, paymentId, amount, billableId?, reference?, raw? }
    await subscriptions.subscribe(event.billableId!, 'pro', { period: 'monthly' })
  }

  reply.code(200).send()
})
```

`verifyWebhook` lança `WebhookInvalidError` (HTTP 400) numa assinatura má e
devolve `null` para eventos verificados que não são pagamentos. Deduplica em
`event.id` se quiseres idempotência entre retentativas.

::: warning Aviso: corpo bruto obrigatório
Tal como no Stripe, a verificação da assinatura corre sobre os bytes intactos do
pedido. Regista a rota com um parser de corpo bruto para que `request.rawBody`
contenha a string original.
:::

::: tip Dica: recorrente = uma referência por período
O ProxyPay não tem cobrança recorrente com cartão em ficheiro. Modela a faturação
recorrente emitindo **uma referência por período**: quando um período termina (ou
em cada fatura), chama `createPayment` de novo para o período seguinte, e ativa
esse período apenas quando o seu webhook `payment.succeeded` chegar. Não há
fallback de polling com `getPayment` no driver do ProxyPay — confia no webhook.
:::

Para desenvolvimento e testes, o `FakePaymentGateway` (de
`@basaltkit/subscriptions`) implementa o mesmo contrato em processo: regista os
pedidos em `payments` e o seu `verifyWebhook` devolve um `payment.succeeded`
sintético.

## Hooks de domínio

O plugin emite hooks no `HookBus` da app — `billing:subscribed`,
`billing:checkout_started`, `billing:swapped`, `billing:canceled`,
`billing:trial_expired`, `billing:webhook`. Subscreve para enviar emails ou
notificações:

```ts
app.hooks.on('billing:trial_expired', ({ subscription }) => {
  // mailer.send(...) / notifier.notify(...)
})
```
