# Subscrições

`@basaltkit/subscriptions` modela a faturação na tua própria base de dados, com
as gateways de pagamento como drivers. A tua app fala com o Basalt; só os drivers
falam com o Stripe, Paddle, Lemon Squeezy — ou, para Angola, ProxyPay/Multicaixa.
As verificações de funcionalidades e as quotas leem estado local, por isso são
instantâneas e nunca chamam a gateway.

[[toc]]

## Modelo mental

A faturação são cinco peças, e saber qual delas é dona de uma pergunta responde a
quase todo o resto:

| Peça | É dona de | Fala com a gateway? |
| --- | --- | --- |
| **Planos** (`definePlans`) | O catálogo: preço, trial, funcionalidades por plano | Não — um objeto simples, lido de forma síncrona |
| **`Subscriptions`** (`SUBSCRIPTIONS`) | *A que é que um billable tem direito agora*: plano, período, estado | Só para movimentos de dinheiro (subscribe, checkout, portal, swap, cancel) |
| **`features(billableId)`** | Imposição: `can`, `limit`, `usage`, `remaining`, `consume` | **Nunca** — lê estado local, por isso é instantâneo em cada pedido |
| **`Invoices`** (`INVOICES`) | *O que lhes foi cobrado*: linhas, desconto, imposto, totais, estado | Não — domínio puro; chamas `markPaid` quando um pagamento confirma |
| **Driver de gateway** | Mover dinheiro e verificar webhooks | Ele *é* a gateway |

A direção da verdade importa: **a tua base de dados é o read model.** Um webhook
da gateway escreve nela (`handleWebhook`), e tudo o resto — guards, verificações
de funcionalidades, imposição de quotas — lê dela. Nenhum caminho de pedido
espera pela Stripe.

O **billable** é o id que passares. Por convenção é o id do tenant, e os route
guards e as rotas HTTP resolvem-no a partir de `ctx().tenant.id`, razão pela qual
a [imposição de pertença ao tenant](/pt/guide/teams) é estrutural para a
faturação — vê o aviso na secção do Stripe mais abaixo.

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

O construtor falha logo se o `fallbackPlan` não existir no catálogo, por isso uma
gralha é um erro de arranque e não um silencioso "ninguém tem funcionalidades".
Todas as opções estão tabeladas em **Referência de opções** mais abaixo.

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
cancelAtPeriodEnd?, canceledAt?, gatewayRef?, pendingPlan?, pendingPeriod? }`
onde `status` é um de
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

O Checkout, o Portal e as rotas de faturas são **autenticados por defeito**
(`meta: { auth: true }`, imposto pelo guard do `@basaltkit/auth`) — devolvem
URLs de gestão de pagamento e o histórico do tenant atual e nunca podem ser
anónimos. Se (e só se) a autenticação acontecer numa edge exterior, desativa
deliberadamente com `billingRoutes({ ..., auth: false })` /
`invoiceRoutes({ auth: false })`. A rota de webhook é a exceção: é autenticada
pela **assinatura** da gateway, nunca por sessão.

::: danger `meta.auth` sozinho não isola tenants
`billingRoutes()` e `invoiceRoutes()` autenticam o **utilizador** mas resolvem o
**billable a partir do tenant** (`ctx().tenant.id`) — e o tenant vem de um header
ou de um `Host`, ambos controlados pelo cliente. A autenticação prova *quem está
a chamar*, não *a que tenant pertence*. Regista o
[`tenantMembershipPlugin()`](/pt/guide/teams) e um utilizador válido do tenant A
que chame `/billing/checkout`, `/billing/portal` ou `/billing/invoices` com o
identificador do tenant B é travado com `403 TEAM_NOT_A_MEMBER` **antes de correr
qualquer código de faturação** — nenhuma sessão de Checkout criada contra o plano
de B, nenhum URL de Portal para o cartão de B, nenhuma leitura do histórico de
pagamentos de B. Sem ele, `meta.auth` deixa qualquer utilizador autenticado
operar sobre a faturação de qualquer tenant. O mesmo se aplica às tuas rotas com
`meta: { subscribed }` / `meta: { feature }`. Vê [Equipas](/pt/guide/teams) e o
[guia de segurança](/pt/guide/security).
:::

O `subscribed` e o `feature` **fazem** parte da verificação de guarded-meta da
framework. O `subscriptionsPlugin` reclama ambas as chaves, por isso uma rota
anotada com `meta: { subscribed: 'pro' }` sem o plugin já não arranca a servir a
funcionalidade paga a toda a gente — o adapter recusa arrancar com
`UnguardedRouteMetaError`, nomeando as rotas em falta. Se o paywall vive mesmo
numa edge exterior, opta por sair deliberadamente com a opção do adapter
`allowUnguardedMeta: ['subscribed', 'feature']`. Cobre à mesma o paywall com um
teste: o check de boot prova que existe um guard *registado*, não que a tua
matriz de planos está correta.

Um Checkout abandonado nunca muda a subscrição ativa: o `checkout()` regista a
intenção como `pendingPlan`, e o plano só muda quando a gateway confirma o
pagamento de uma **nova** subscrição — uma renovação da subscrição atual
(mesmo `gatewayRef`) não pode ativar um plano escalado.

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
  // Opcional — predefine para apiKey, que é com o que o ProxyPay assina o callback
  webhookSecret: process.env.PROXYPAY_WEBHOOK_SECRET,
})
```

| Opção | Tipo | Predefinição | Finalidade |
| --- | --- | --- | --- |
| `apiKey` | `string` | — (obrigatório) | Enviado como `Authorization: Token <apiKey>` |
| `entity` | `string` | — (obrigatório) | A tua Entidade Multicaixa, atribuída pelo ProxyPay/EMIS |
| `sandbox` | `boolean` | `false` | Usa o host de sandbox `api.sandbox.proxypay.co.ao` |
| `baseUrl` | `string` | derivado de `sandbox` | Substitui o URL base por completo |
| `webhookSecret` | `string` | **a tua `apiKey`** | HMAC-SHA256 (hex) sobre o corpo raw, no `x-signature`. A verificação está portanto **ligada de origem**; passa `''` para a desativar por completo |
| `callbackUrl` | `string` | — | Devolvido no webhook como `custom_fields.callback_url`. O destino real de entrega do ProxyPay define-se na conta, no dashboard |
| `expiryDays` | `number` | `30` | Janela de validade de recurso quando `PaymentRequest.expiresAt` é omitido — o ProxyPay *exige* uma data de fim, por isso é sempre enviada |
| `fetch` | `FetchLike` | `fetch` global | Fetch injetado |

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

## Referência de opções

### `subscriptionsPlugin(options)`

As mesmas opções de `new Subscriptions(...)` menos `hooks` (o plugin passa o
`HookBus` da app), mais `invoices`.

| Opção | Tipo | Predefinição | Finalidade |
| --- | --- | --- | --- |
| `plans` | `Plans` | — (obrigatório) | O catálogo vindo de `definePlans` ou de `loadPlans(store)`. É consumido de forma síncrona, por isso tem de estar totalmente resolvido antes do arranque |
| `fallbackPlan` | `string` | — | Plano aplicado a billables sem subscrição (habitualmente `'free'`). Validado na construção — um nome desconhecido lança `UnknownPlanError` de imediato |
| `gateway` | `BillingGateway` | — | Driver de subscrições com cartão (Stripe, Paddle, Lemon Squeezy). Sem ele tudo continua a funcionar localmente; só `checkout`/`portal` o exigem |
| `store` | `SubscriptionStore` | em memória | Onde vivem as subscrições — troca por `subscriptions-sqlite`/`-prisma` ou desaparecem no restart |
| `usage` | `UsageStore` | em memória | Contadores de medição. O predefinido é por processo, por isso uma quota **pode ser ultrapassada** entre réplicas; usa SQLite/Prisma/Redis para um `consume` atómico |
| `webhooks` | `WebhookStore` | em memória | Deduplicação de eventos da gateway por id. Por processo por predefinição, o que significa que um retry que caia noutra réplica é reprocessado |
| `invoices` | `InvoicesOptions` | `{}` | Configuração do motor `Invoices` registado sob `INVOICES` (abaixo) |

### `billingRoutes(options)`

| Opção | Tipo | Predefinição | Finalidade |
| --- | --- | --- | --- |
| `successUrl` | `string` | — (obrigatório) | Para onde a gateway devolve o cliente depois do Checkout. O corpo do pedido pode sobrepor-se por chamada |
| `cancelUrl` | `string` | — (obrigatório) | Para onde volta um Checkout abandonado |
| `portalReturnUrl` | `string` | `successUrl` | Para onde volta o Portal do Cliente |
| `auth` | `boolean` | `true` | Exige `meta: { auth: true }` em ambas as rotas. Põe `false` **só** quando a autenticação acontece numa borda exterior — estas rotas criam URLs de gestão de pagamento reais |

`POST /billing/checkout` recebe `{ plan, period?, successUrl?, cancelUrl? }` e
`POST /billing/portal` recebe um `{ returnUrl }` opcional; ambos devolvem
`{ url }`.

### `invoiceRoutes(options)`

| Opção | Tipo | Predefinição | Finalidade |
| --- | --- | --- | --- |
| `auth` | `boolean` | `true` | A mesma regra de `billingRoutes` — as faturas são o histórico de pagamentos do tenant |

As três rotas são só de leitura e verificam a propriedade: uma fatura cujo
`billableId` não seja o tenant atual lê-se como `404 INVOICE_NOT_FOUND`, nunca
como os dados de outra pessoa. Emitir e finalizar ficam do lado do servidor,
através de `INVOICES`.

### `billingWebhookRoute(gateway)`

Recebe a instância da gateway como único argumento — sem opções. Deliberadamente
**não** é protegida por `meta.auth`: a assinatura da gateway é a autenticação.
Devolve `200 { received: true, ignored: true }` para um evento que o driver não
mapeia, e `200 { received: true, duplicate: true }` para um já processado.

### `Invoices` — `InvoicesOptions`

| Opção | Tipo | Predefinição | Finalidade |
| --- | --- | --- | --- |
| `store` | `InvoiceStore` | `MemoryInvoiceStore` | Faturas duráveis; é também dono de `nextNumber()`, que tem de alocar de forma atómica |
| `numberPrefix` | `string` | `'INV'` | Prefixo do número humano da fatura — `INV-2026-0001` |
| `taxRate` | `number` | `0` | Aplicado a (subtotal − desconto) quando um rascunho omite `tax`. `0.14` = 14% |
| `now` | `() => number` | `Date.now` | Relógio injetável (testes, retroatividade) |
| `idFactory` | `() => string` | `randomUUID` | Gerador de ids injetável |

### `Coupons` — `CouponsOptions`

| Opção | Tipo | Predefinição | Finalidade |
| --- | --- | --- | --- |
| `store` | `CouponStore` | `MemoryCouponStore` | Registo durável de cupões; `incrementRedemptions` tem de ser atómico ou `maxRedemptions` escapa |
| `now` | `() => number` | `Date.now` | Relógio injetável, para o `redeemBy` |

### `StripeBillingGateway(options)`

| Opção | Tipo | Predefinição | Finalidade |
| --- | --- | --- | --- |
| `secretKey` | `string` | — (obrigatório) | Chave secreta da API do Stripe |
| `webhookSecret` | `string` | — (obrigatório) | Segredo de assinatura do endpoint (`whsec_…`). Sem ele a verificação falha fechada |
| `priceId` | `(plan, period) => string` | — (obrigatório) | Mapeia um plano + período para um Price ID do Stripe |
| `customerId` | `(billableId) => string \| Promise<string>` | — (obrigatório) | Resolve (ou cria) o Customer do Stripe para um billable |
| `resolveBillableId` | `(event) => string \| undefined` | lê `data.object.metadata.billableId` | Sobrepõe quando os teus eventos levam o id noutro sítio |
| `tolerance` | `number` (segundos) | `300` | Tolerância do timestamp do webhook — janela de replay |
| `fetch` | `typeof fetch` | `fetch` global | Cliente HTTP injetado (testes) |
| `now` | `() => number` | `Date.now` | Relógio injetável em ms |
| `apiBase` | `string` | `https://api.stripe.com` | Base da API, para mocks |

### `PaddleBillingGateway(options)`

| Opção | Tipo | Predefinição | Finalidade |
| --- | --- | --- | --- |
| `apiKey` | `string` | — (obrigatório) | Chave da API do Paddle (Bearer) |
| `webhookSecret` | `string` | — (obrigatório) | Segredo de assinatura das notificações; verifica o esquema `Paddle-Signature` (`ts=…;h1=…`) |
| `priceId` | `(plan, period) => string` | — (obrigatório) | Mapeia um plano + período para um Price ID do Paddle (`pri_…`) |
| `customerId` | `(billableId) => string \| Promise<string>` | — (obrigatório) | Customer ID do Paddle (`ctm_…`) |
| `resolveBillableId` | `(event) => string \| undefined` | lê `data.custom_data.billableId` | Sobrepõe para eventos que levem o id noutro sítio |
| `tolerance` | `number` (segundos) | `300` | Tolerância do timestamp do webhook |
| `fetch` / `now` / `apiBase` | — | `fetch` global / `Date.now` / `https://api.paddle.com` | Pontos de injeção para testes |

O Paddle é checkout-first: tanto `createSubscription` como
`createCheckoutSession` criam uma **transação**, e o id durável da subscrição
chega mais tarde num webhook `subscription.*` como `gatewayRef`.

### `LemonSqueezyBillingGateway(options)`

| Opção | Tipo | Predefinição | Finalidade |
| --- | --- | --- | --- |
| `apiKey` | `string` | — (obrigatório) | Chave da API do Lemon Squeezy (Bearer) |
| `webhookSecret` | `string` | — (obrigatório) | Verifica o header `X-Signature` (HMAC-SHA256 hex sobre o corpo raw) |
| `storeId` | `string` | — (obrigatório) | O id da tua loja — necessário para criar checkouts |
| `variantId` | `(plan, period) => string` | — (obrigatório) | Mapeia um plano + período para um Variant ID |
| `customerId` | `(billableId) => string \| Promise<string>` | — | **Só obrigatório para o portal**; sem ele o `portal()` não tem nada para abrir |
| `resolveBillableId` | `(event) => string \| undefined` | lê `meta.custom_data.billableId` | Sobrepõe para eventos que levem o id noutro sítio |
| `fetch` / `apiBase` | — | `fetch` global / `https://api.lemonsqueezy.com/v1` | Pontos de injeção para testes |

O Lemon Squeezy é merchant of record e checkout-first, com a mesma forma de "o id
da subscrição chega por webhook" do Paddle. Não tem tolerância de timestamp — o
esquema `X-Signature` não leva timestamp.

### `ProxyPayGateway(options)` / `AppyPayGateway(options)`

Estes implementam o contrato `PaymentGateway` por referência, não o
`BillingGateway`. As opções do ProxyPay estão tabeladas em **Construir a
gateway**, acima; o AppyPay (`@basaltkit/subscriptions-appypay`, pré-lançamento)
acrescenta OAuth2 (`clientId`, `clientSecret`, `tokenUrl`, `scope?`) e
`defaultMethod`. A história completa está em
[Pagamentos por referência e mobile money](/pt/guide/reference-payments).

### Fábricas de stores duráveis

| Fábrica | Pacote | Devolve |
| --- | --- | --- |
| `sqliteSubscriptionsStores(dbOrLocation = ':memory:')` | `@basaltkit/subscriptions-sqlite` | `{ db, store, usage, webhooks }` — abre e migra |
| `prismaSubscriptionsStores(client)` | `@basaltkit/subscriptions-prisma` | `{ store, usage, webhooks }` — lança de imediato se o cliente não tiver o modelo `subscription` |
| `sqlitePaymentStores(...)` / `prismaPaymentStores(client)` | os mesmos pacotes | O `PaymentStore` + `RecurringStore` para pagamentos por referência |
| `renderInvoicePdf(invoice, { locale?, businessName? })` | `@basaltkit/subscriptions-pdf` | `Promise<Buffer>` — mantém o pdfkit fora do core |

## Modos de falha e resolução de problemas

| Erro | Código | HTTP | Quando |
| --- | --- | --- | --- |
| `NotSubscribedError` | `BILLING_SUBSCRIPTION_REQUIRED` | 402 | `meta.subscribed` não satisfeito; **ou sem tenant no contexto** numa rota de faturação/faturas; ou `swap`/`cancel`/`resume` sem subscrição ativa |
| `FeatureUnavailableError` | `BILLING_FEATURE_UNAVAILABLE` | 403 | `meta.feature` não concedido; ou `consume()` numa funcionalidade cujo limite é 0 (ou sem plano e sem `fallbackPlan`) |
| `QuotaExceededError` | `BILLING_QUOTA_EXCEEDED` | 402 | O `consume()` levaria o uso para além do limite — a verificação atómica do store recusou |
| `GatewayUnsupportedError` | `BILLING_GATEWAY_UNSUPPORTED` | 501 | `checkout()` ou `portal()` sem gateway, ou com uma que não implementa essa capacidade |
| `UnknownPlanError` | `BILLING_UNKNOWN_PLAN` | — | Um nome de plano ausente do catálogo — incluindo um `fallbackPlan` mal escrito, que lança na construção |
| `WebhookInvalidError` | `BILLING_WEBHOOK_INVALID` | 400 | A verificação da assinatura falhou — quase sempre um corpo já processado (reserializado) |
| `WebhookSecretMissingError` | `BILLING_WEBHOOK_SECRET_MISSING` | 500 | `verifyWebhook` sem segredo de assinatura configurado. Falha fechada: um callback sem assinatura nunca é confiável |
| `PaymentAmountMismatchError` | `BILLING_PAYMENT_AMOUNT_MISMATCH` | 400 | O montante de um pagamento confirmado ≠ o montante pedido para esse id — pagamento a menos ou callback forjado |
| `StripeRequestError` · `PaddleRequestError` · `LemonSqueezyRequestError` | `BILLING_GATEWAY_ERROR` | — | A API REST da gateway devolveu um não-2xx; o estado original está em `err.httpStatus` |
| `InvoiceNotFoundError` | `INVOICE_NOT_FOUND` | 404 | Id de fatura desconhecido — **ou** um que pertence a outro tenant, via `invoiceRoutes` |
| `InvoiceStateError` | `INVOICE_INVALID_STATE` | 409 | `finalize` de algo que não é rascunho, `markPaid` de algo que não está aberto, `void` de uma paga, `addLine` numa finalizada — ou `planLine()` sobre um preço `'custom'` |
| `CouponInvalidError` | `COUPON_INVALID` | 422 | Forma inválida: os dois/nenhum de `percentOff`/`amountOff`, percentagem fora de 0–100, `amountOff` sem moeda, `maxRedemptions < 1` |
| `CouponNotRedeemableError` | `COUPON_NOT_REDEEMABLE` | 422 | Expirado (`redeemBy`), limite de resgates atingido, ou a moeda da fatura difere da de um cupão de montante fixo |
| `CouponNotFoundError` | `COUPON_NOT_FOUND` | 404 | Não existe cupão com esse código |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | arranque | `billingRoutes()`/`invoiceRoutes()` registados com o `auth: true` predefinido mas sem `authPlugin` |

- **`400 BILLING_WEBHOOK_INVALID` que não desaparece** — a assinatura é calculada
  sobre os bytes intocados do pedido. Configura um parser de corpo raw para
  `/billing/webhook`; reserializar um objeto já processado muda os bytes e parte
  o HMAC.
- **Todos os pedidos recebem `402 BILLING_SUBSCRIPTION_REQUIRED`, mesmo no plano
  gratuito** — o guard resolve o billable a partir de `ctx().tenant.id`. Sem
  plugin de tenancy, ou sem identificador de tenant no pedido, não há billable.
  Verifica primeiro a tenancy; depois verifica se `fallbackPlan` está definido.
- **Uma quota foi ultrapassada sob carga** — o `UsageStore` em memória é por
  processo. Só os stores SQLite, Prisma e Redis fazem um check-and-increment
  realmente atómico (`updateMany` condicional / um único `EVAL` em Lua).
- **Um webhook foi aplicado duas vezes depois de um retry da gateway** — o
  `WebhookStore` de deduplicação é em memória por predefinição, por isso um retry
  que caia noutra réplica parece novo. Usa o `RedisWebhookStore` ou o de
  SQLite/Prisma. (Dentro de um processo é exato: uma escrita de estado falhada
  liberta a reserva para o retry poder reprocessar.)
- **Um utilizador do tenant A abriu o Checkout do tenant B** — `meta.auth` prova
  identidade, não pertença. Regista o
  [`tenantMembershipPlugin()`](/pt/guide/teams).
- **`501 BILLING_GATEWAY_UNSUPPORTED` a partir de `/billing/portal`** — o driver
  não implementa `createPortalSession` para a tua configuração; o Lemon Squeezy,
  por exemplo, precisa de `customerId` para abrir um.
- **Um Checkout abandonado não mudou nada, como esperado** — o `checkout()` só
  regista `pendingPlan`/`pendingPeriod`. O plano só é promovido quando chega um
  `payment.succeeded` com um `gatewayRef` **novo**, por isso uma renovação da
  subscrição existente nunca consegue escalar o plano.
- **Os trials nunca expiram** — os trials suportados pela gateway são liquidados
  pelo webhook da gateway e são deliberadamente ignorados pelo `expireTrials()`.
  Os trials locais (sem gateway) precisam de `expireTrials()` a correr a partir do
  [scheduler](/pt/guide/scheduler).

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
