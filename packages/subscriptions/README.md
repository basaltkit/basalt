# @machize/subscriptions

Faturação para o framework Machize, ao estilo Laravel Cashier/Soulbscription: planos declarativos, subscrições com período experimental, funcionalidades com limites de utilização, integração com Stripe e webhooks idempotentes. Precisas deste módulo quando a tua aplicação SaaS cobra mensalidades e limita funcionalidades por plano.

## O que este módulo resolve

Num SaaS típico vendes **planos** (ex.: Free, Pro, Enterprise): um plano é um pacote com um preço e um conjunto de **funcionalidades** — coisas que o cliente pode ou não fazer, e em que quantidade (3 projetos no Free, 50 no Pro; 1000 chamadas à API por mês). Uma **subscrição** é a ligação entre um cliente e um plano, com um estado (ativa, em período experimental, pagamento em atraso, cancelada).

Implementar isto à mão é traiçoeiro: períodos experimentais que expiram, mudanças de plano a meio do mês (com *proration* — o acerto proporcional do valor), limites mensais que têm de reiniciar, e a sincronização com o processador de pagamentos (o *gateway*, ex.: Stripe), que comunica por **webhooks** — pedidos HTTP que o gateway envia à tua aplicação quando um pagamento acontece ou falha. Esses webhooks chegam repetidos e fora de ordem, e processá-los duas vezes corrompe o estado.

Este módulo dá-te tudo isso pronto: defines os planos em código (`definePlans`), geres o ciclo de vida (`subscribe`, `checkout`, `swap`, `cancel`, `resume`), verificas e consomes funcionalidades (`features(...).can/consume`, com quotas atómicas que nunca são ultrapassadas mesmo com pedidos concorrentes) e processas webhooks de forma **idempotente** (cada evento é aplicado uma única vez, mesmo que chegue dez vezes). O estado local é a "fonte de leitura": verificar uma funcionalidade nunca faz chamadas ao Stripe.

## Instalação

```bash
pnpm add @machize/subscriptions
```

O pacote depende de `@machize/core` e `@machize/fastify` (para as rotas e guards HTTP) e tem `zod` como *peer dependency*.

## Começar em 5 minutos

1. **Define os planos.** `price: 0` é grátis; um objeto dá preços mensal/anual; `'custom'` é "fale connosco". As funcionalidades podem ser: booleano (liga/desliga), número (saldo vitalício), `meter(n)` (quota que reinicia todos os meses) ou `Infinity` (ilimitado):

```ts
// src/billing/plans.ts
import { definePlans, meter } from '@machize/subscriptions'

export const plans = definePlans({
  free: { price: 0, features: { projects: 3, api: false } },
  pro: {
    price: { monthly: 29, yearly: 290 },
    trial: '14d', // período experimental de 14 dias
    features: { projects: 50, api: true, 'api.requests': meter(1000) },
  },
  scale: { price: 'custom', features: { projects: Number.POSITIVE_INFINITY, api: true } },
})
```

2. **Cria o serviço** (sem gateway, para já — tudo funciona localmente):

```ts
// src/billing/subscriptions.ts
import { Subscriptions } from '@machize/subscriptions'
import { plans } from './plans.js'

export const subscriptions = new Subscriptions({
  plans,
  fallbackPlan: 'free', // plano aplicado a quem não tem subscrição
})
```

3. **Subscreve um cliente.** O `billableId` é o identificador de quem paga — por convenção, o id do tenant:

```ts
const record = await subscriptions.subscribe('acme', 'pro')
console.log(record.status)                       // 'trialing' (o plano tem trial)
console.log(await subscriptions.subscribed('acme')) // true
console.log(await subscriptions.onTrial('acme'))    // true
```

4. **Verifica e consome funcionalidades:**

```ts
const features = subscriptions.features('acme')

console.log(await features.can('api'))            // true
console.log(await features.remaining('projects')) // 50

await features.consume('projects', 2)             // regista a criação de 2 projetos
console.log(await features.remaining('projects')) // 48
```

5. Quando o limite se esgota, `consume` lança `QuotaExceededError`; uma funcionalidade desligada no plano lança `FeatureUnavailableError`. Basta apanhar estes erros para mostrar "faça upgrade".

## Guia de utilização

### Definir planos

Cada plano (`PlanDefinition`) tem:

| Campo | Tipo | Obrigatório? | Descrição |
|---|---|---|---|
| `price` | `number \| { monthly, yearly } \| 'custom'` | Sim | `0` = grátis; número = mesmo preço nos dois períodos; `'custom'` = vendas |
| `trial` | `DurationInput` (ex.: `'14d'`) | Não | Duração do período experimental |
| `features` | `Record<string, FeatureValue>` | Sim | `boolean` (flag) · `number` (saldo vitalício) · `meter(n)` (quota mensal) · `Infinity` (ilimitado) |

Os contadores de `meter(n)` reiniciam a cada mês de calendário (bucket `YYYY-MM`); os saldos numéricos são vitalícios.

### Subscrever

```ts
await subscriptions.subscribe('acme', 'pro')                        // mensal (default)
await subscriptions.subscribe('acme', 'pro', { period: 'yearly' })  // anual
```

- Plano com `trial` → estado `trialing` até ao fim do período experimental.
- Com um gateway configurado, planos **pagos** são criados também no gateway (com o trial em dias, se existir); planos grátis nunca tocam no gateway.
- Alternativa recomendada em produção: **Checkout** (o cliente introduz o cartão numa página alojada pelo gateway):

```ts
const { url } = await subscriptions.checkout('acme', 'pro', {
  successUrl: 'https://app.exemplo.com/obrigado',
  cancelUrl: 'https://app.exemplo.com/precos',
})
// redireciona o cliente para `url`; a subscrição fica 'incomplete'
// e passa a 'active' quando o webhook payment.succeeded chegar
```

### Mudar de plano (swap)

```ts
await subscriptions.swap('acme', 'scale')                    // com proration (acerto imediato)
await subscriptions.swap('acme', 'scale', { prorate: false }) // muda só na próxima renovação
```

Exige uma subscrição ativa (senão `NotSubscribedError`). Se a subscrição estiver ligada ao gateway, a mudança é empurrada para lá com o comportamento de proration escolhido.

### Cancelar e retomar

```ts
await subscriptions.cancel('acme')                        // no fim do período (default) — continua ativa até lá
await subscriptions.resume('acme')                        // arrepende-se antes do fim: anula o cancelamento
await subscriptions.cancel('acme', { atPeriodEnd: false }) // imediato: status 'canceled' já
```

### Portal do cliente (autosserviço)

```ts
const { url } = await subscriptions.portal('acme', { returnUrl: 'https://app.exemplo.com/conta' })
// redireciona para `url` — o cliente atualiza o cartão, muda de plano ou cancela sozinho
```

### Funcionalidades: a API `features(billableId)`

| Método | Devolve | Descrição |
|---|---|---|
| `can(feature)` | `Promise<boolean>` | O plano dá acesso (limite > 0)? |
| `limit(feature)` | `Promise<number>` | Limite normalizado (`false`→0, `true`→`Infinity`) |
| `usage(feature)` | `Promise<number>` | Consumo no período atual |
| `remaining(feature)` | `Promise<number>` | Quanto ainda pode consumir |
| `consume(feature, amount = 1)` | `Promise<number>` | Regista consumo atomicamente; lança `QuotaExceededError` se ultrapassar, `FeatureUnavailableError` se não houver acesso |

Quem não tem subscrição ativa usa o `fallbackPlan` (se definido); sem fallback, não tem acesso a nada.

### Períodos experimentais

- Trials **locais** (sem gateway): corre `expireTrials()` periodicamente (ex.: a partir do scheduler). Plano grátis → `active`; plano pago → `past_due`.
- Trials **geridos pelo gateway**: o gateway cobra no fim do trial e o webhook faz a transição (`payment.succeeded` → `active`, `payment.failed` → `past_due`). O `expireTrials()` ignora-os de propósito.

### Gateway Stripe

O driver fala diretamente com a API REST do Stripe (sem SDK). Tens de lhe dizer como mapear os teus planos para *Price IDs* do Stripe e como obter o *Customer ID* de cada billable:

```ts
import { StripeBillingGateway, Subscriptions } from '@machize/subscriptions'
import { plans } from './plans.js'

const gateway = new StripeBillingGateway({
  secretKey: process.env.STRIPE_SECRET_KEY!,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!, // whsec_...
  priceId: (plan, period) => ({
    pro: { monthly: 'price_pro_m', yearly: 'price_pro_y' },
  })[plan]![period],
  customerId: async (billableId) => obterOuCriarStripeCustomer(billableId),
})

export const subscriptions = new Subscriptions({ plans, gateway, fallbackPlan: 'free' })
```

Para desenvolvimento e testes existe o `FakeBillingGateway`, que regista todas as chamadas em arrays (`created`, `canceled`, `checkouts`, `portals`, `swaps`) e aceita a assinatura de webhook `'valid'`.

### Webhooks do gateway

`handleWebhook(event)` aplica um `WebhookEvent` já traduzido para termos de domínio: `subscription.canceled` → `canceled`, `payment.failed` → `past_due`, `payment.succeeded` → `active`. O processamento é idempotente por `event.id` (devolve `false` para duplicados) e, se gravar o estado falhar, o id é libertado para o retry do gateway poder reprocessar.

Em HTTP, usa a rota pronta (secção seguinte) — a verificação de assinatura é feita pelo driver do gateway.

### Integração HTTP (plugin, guards e rotas)

O `subscriptionsPlugin` regista o serviço no contentor (token `SUBSCRIPTIONS`) e adiciona **guards** de rota: com `meta: { subscribed: true | 'plano' }` a rota exige subscrição ativa (senão HTTP 402); com `meta: { feature: 'api' }` exige a funcionalidade (senão HTTP 403). O billable é o tenant do contexto do pedido.

```ts
import { createApp } from '@machize/core'
import { fastifyPlugin, route } from '@machize/fastify'
import {
  billingRoutes,
  billingWebhookRoute,
  subscriptionsPlugin,
} from '@machize/subscriptions'
import { plans } from './billing/plans.js'
import { gateway } from './billing/gateway.js'

const app = await createApp({
  plugins: [
    // ... o teu plugin de tenancy, que coloca context.tenant ...
    subscriptionsPlugin({ plans, fallbackPlan: 'free', gateway }),
    fastifyPlugin({
      routes: [
        route({
          method: 'GET',
          url: '/reports',
          meta: { subscribed: 'pro' },   // exige o plano "pro"
          async handler() { return { ok: true } },
        }),
        route({
          method: 'GET',
          url: '/api-data',
          meta: { feature: 'api' },      // exige a funcionalidade "api"
          async handler() { return { data: [] } },
        }),
        ...billingRoutes({
          successUrl: 'https://app.exemplo.com/obrigado',
          cancelUrl: 'https://app.exemplo.com/precos',
        }),
        billingWebhookRoute(gateway),
      ],
    }),
  ],
}).boot()
```

Rotas criadas:

- `POST /billing/checkout` — corpo `{ plan, period?, successUrl?, cancelUrl? }`, devolve `{ url }` para redirecionar;
- `POST /billing/portal` — corpo opcional `{ returnUrl? }`, devolve `{ url }`;
- `POST /billing/webhook` — endpoint para o gateway; devolve 200 com `{ received, duplicate }`.

Importante: o Stripe verifica a assinatura sobre o **corpo bruto** do pedido. Configura um parser de raw body para a rota do webhook, para `request.body` chegar como string.

### Produção: stores Redis

Os stores em memória são por processo. Em produção:

```ts
import { Redis } from 'ioredis'
import { RedisUsageStore, RedisWebhookStore, Subscriptions } from '@machize/subscriptions'
import { plans } from './plans.js'

const redis = new Redis(process.env.REDIS_URL!)

export const subscriptions = new Subscriptions({
  plans,
  usage: new RedisUsageStore(redis),      // quotas atómicas via script Lua (EVAL)
  webhooks: new RedisWebhookStore(redis), // dedupe durável via SET NX EX
  // store: implementa SubscriptionStore sobre a tua base de dados
})
```

O `SubscriptionStore` (as subscrições em si) deve viver na tua base de dados — implementa `get/save/all`.

### Hooks de domínio

O plugin emite hooks no `HookBus` do Machize: `billing:subscribed`, `billing:checkout_started`, `billing:swapped`, `billing:canceled`, `billing:trial_expired`, `billing:webhook`. Usa-os para enviar emails/notificações:

```ts
app.hooks.on('billing:trial_expired', ({ subscription }) => {
  // ex.: notifier.notify(...) ou mailer.send(...)
})
```

## Referência da API

### Planos

| Export | Assinatura | Descrição |
|---|---|---|
| `definePlans` | `<T extends Plans>(plans: T) => T` | Declara o catálogo de planos (preserva os tipos) |
| `meter` | `(limit: number) => Meter` | Funcionalidade medida com reinício mensal |
| `planPrice` | `(plan, period) => number \| 'custom'` | Preço de um plano num período |
| `featureLimit` | `(value?) => number` | Limite normalizado (`false`→0, `true`→`Infinity`) |
| `isMeter` | `(value?) => value is Meter` | (Avançado) testa se um valor é um meter |
| `UnknownPlanError` | erro | `BILLING_UNKNOWN_PLAN` — plano não definido |

### `class Subscriptions`

`new Subscriptions(options: SubscriptionsOptions)`:

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `plans` | `Plans` | Sim | — | Catálogo de planos |
| `store` | `SubscriptionStore` | Não | `MemorySubscriptionStore` | Persistência das subscrições |
| `usage` | `UsageStore` | Não | `MemoryUsageStore` | Contadores de consumo |
| `gateway` | `BillingGateway` | Não | — | Processador de pagamentos |
| `webhooks` | `WebhookStore` | Não | `MemoryWebhookStore` | Dedupe de webhooks (Redis em produção) |
| `fallbackPlan` | `string` | Não | — | Plano de quem não tem subscrição (valida no arranque) |
| `hooks` | `HookBus` | Não | — | Bus de hooks (o plugin passa-o automaticamente) |

Métodos:

| Método | Assinatura | Descrição |
|---|---|---|
| `plan` | `(name) => PlanDefinition` | Obtém um plano; lança `UnknownPlanError` |
| `subscribe` | `(billableId, plan, { period? }?) => Promise<SubscriptionRecord>` | Cria a subscrição (gateway só para planos pagos) |
| `checkout` | `(billableId, plan, { period?, successUrl, cancelUrl }) => Promise<{ url }>` | Sessão de Checkout alojado; grava estado `incomplete` |
| `portal` | `(billableId, { returnUrl }) => Promise<{ url }>` | Sessão do Customer Portal |
| `get` | `(billableId) => Promise<SubscriptionRecord \| null>` | Lê a subscrição |
| `subscribed` | `(billableId, plan?) => Promise<boolean>` | Ativa (ou em trial válido), opcionalmente num plano específico |
| `onTrial` | `(billableId) => Promise<boolean>` | Está em período experimental? |
| `swap` | `(billableId, plan, { prorate? }?) => Promise<SubscriptionRecord>` | Muda de plano (proration por default) |
| `cancel` | `(billableId, { atPeriodEnd? }?) => Promise<SubscriptionRecord>` | Cancela (no fim do período por default) |
| `resume` | `(billableId) => Promise<SubscriptionRecord>` | Anula um cancelamento agendado |
| `features` | `(billableId) => { can, limit, usage, remaining, consume }` | API de funcionalidades (ver acima) |
| `handleWebhook` | `(event: WebhookEvent) => Promise<boolean>` | Aplica um evento idempotentemente; `false` = duplicado |
| `expireTrials` | `() => Promise<SubscriptionRecord[]>` | Liquida trials locais expirados (correr no scheduler) |

`SubscriptionRecord`: `{ billableId, plan, period, status, trialEndsAt?, cancelAtPeriodEnd?, canceledAt?, gatewayRef? }` com `status ∈ 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete'`.

Erros (todos com `code` e `status` HTTP): `NotSubscribedError` (`BILLING_SUBSCRIPTION_REQUIRED`, 402), `FeatureUnavailableError` (`BILLING_FEATURE_UNAVAILABLE`, 403), `QuotaExceededError` (`BILLING_QUOTA_EXCEEDED`, 402), `GatewayUnsupportedError` (`BILLING_GATEWAY_UNSUPPORTED`, 501).

### Gateways

`BillingGateway` (Avançado — contrato para escrever um driver de gateway): `name`, `createSubscription`, `cancelSubscription`, `verifyWebhook` e, opcionais, `createCheckoutSession`, `createPortalSession`, `swapSubscription`. O `verifyWebhook(rawBody, signature)` valida a assinatura (lança `WebhookInvalidError`, `BILLING_WEBHOOK_INVALID`, 400) e traduz o payload num `WebhookEvent` — `{ id, type, billableId, gatewayRef? }` com `type ∈ 'subscription.canceled' | 'payment.failed' | 'payment.succeeded'` — ou `null` para eventos verificados mas irrelevantes.

`StripeGatewayOptions`:

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `secretKey` | `string` | Sim | — | Chave secreta da API Stripe |
| `webhookSecret` | `string` | Sim | — | Segredo do endpoint (`whsec_...`) |
| `priceId` | `(plan, period) => string` | Sim | — | Mapeia plano+período → Stripe Price ID |
| `customerId` | `(billableId) => string \| Promise<string>` | Sim | — | Obtém/garante o Stripe Customer ID |
| `resolveBillableId` | `(event) => string \| undefined` | Não | lê `metadata.billableId` | (Avançado) extrai o billable de um evento |
| `tolerance` | `number` | Não | `300` | Tolerância do timestamp do webhook (segundos) |
| `fetch` / `now` / `apiBase` | — | Não | globais | (Avançado) injeções para testes |

Erro específico: `StripeRequestError` (`BILLING_GATEWAY_ERROR`, com `httpStatus`).

`FakeBillingGateway` — gateway de teste/desenvolvimento; regista chamadas em `created`, `canceled`, `checkouts`, `portals`, `swaps` e aceita apenas a assinatura `'valid'` em `verifyWebhook`.

### Stores

| Export | Descrição |
|---|---|
| `SubscriptionStore` (Avançado) | `get/save/all` — implementa sobre a tua BD; `MemorySubscriptionStore` incluído |
| `UsageStore` (Avançado) | `get/increment/consume` — `consume` tem de ser atómico; `MemoryUsageStore` incluído |
| `WebhookStore` (Avançado) | `markProcessed(id)` (claim; `true` = novo) / `release(id)`; `MemoryWebhookStore` incluído |
| `RedisUsageStore` | `new RedisUsageStore(redis, { prefix? = 'mach:usage', ttlSeconds? = 60 dias })` — quotas atómicas via EVAL |
| `RedisWebhookStore` | `new RedisWebhookStore(redis, { prefix? = 'mach:webhook', ttlSeconds? = 7 dias })` — dedupe durável via SET NX EX |
| `RedisLike` / `RedisWebhookClient` | (Avançado) superfícies mínimas compatíveis com ioredis — injeta o teu cliente |

### Plugin e rotas HTTP

| Export | Descrição |
|---|---|
| `SUBSCRIPTIONS` | Token do serviço no contentor |
| `subscriptionsPlugin(options)` | Regista o serviço e os guards `meta.subscribed`/`meta.feature`; `options` = `SubscriptionsOptions` sem `hooks` |
| `billingRoutes({ successUrl, cancelUrl, portalReturnUrl? })` | Rotas `POST /billing/checkout` e `POST /billing/portal` para o tenant atual |
| `billingWebhookRoute(gateway)` | Rota `POST /billing/webhook` — assinatura verificada pelo driver, processamento idempotente |

## Erros comuns e soluções (FAQ)

**HTTP 402 `BILLING_SUBSCRIPTION_REQUIRED` numa rota com guard** — O tenant do pedido não tem subscrição ativa (ou não há tenant no contexto). Verifica o plugin de tenancy e se o cliente subscreveu.

**`QuotaExceededError` inesperado** — O limite do plano esgotou-se no período atual. Lembra-te: `meter(n)` reinicia por mês de calendário; um `number` simples é um saldo vitalício que nunca reinicia.

**O webhook do Stripe devolve sempre 400 `BILLING_WEBHOOK_INVALID`** — Quase sempre é o corpo bruto: o Stripe assina os bytes exatos e qualquer re-serialização parte o HMAC. Configura raw body na rota do webhook e confirma o `webhookSecret`. Verifica também relógios (tolerância de 5 minutos).

**Depois do Checkout a subscrição fica `incomplete` para sempre** — O webhook `payment.succeeded` nunca chegou. Confirma que o endpoint `/billing/webhook` está acessível ao Stripe e que os eventos `invoice.paid`/`invoice.payment_succeeded` estão ativados no endpoint do Stripe.

**`GatewayUnsupportedError` ao chamar `checkout`/`portal`** — Não configuraste `gateway`, ou o driver não implementa essa capacidade. Passa um `StripeBillingGateway` (ou `FakeBillingGateway` em dev).

**Trials pagos nunca passam a `active`** — Trials com gateway são convertidos pelo webhook do gateway, não pelo `expireTrials()`. Sem gateway, tens mesmo de correr `expireTrials()` num scheduler (e um trial de plano pago local termina em `past_due`, porque não há forma de cobrar).

**Quotas ultrapassadas com tráfego concorrente em produção** — Estás com o `MemoryUsageStore` em vários processos: cada processo tem o seu contador. Usa `RedisUsageStore`, cujo script Lua garante o check-and-increment atómico entre instâncias.

## Como se liga aos outros módulos

- **@machize/core** — `createApp`, contentor (token `SUBSCRIPTIONS`), contexto do pedido (de onde vem o tenant/billable) e `HookBus` (hooks `billing:*`).
- **@machize/fastify** — as rotas (`billingRoutes`, `billingWebhookRoute`) e os guards `meta.subscribed`/`meta.feature` assentam no plugin HTTP.
- **@machize/mailer** e **@machize/notifications** — subscreve os hooks `billing:*` para enviar emails/notificações ("o teu trial expirou", "pagamento falhou").
- **@machize/webhooks** — direção oposta: este módulo *recebe* webhooks do gateway; o `@machize/webhooks` *envia* webhooks aos teus clientes (podes reencaminhar eventos `billing:*` para lá).
- **@machize/scheduler** — o sítio natural para correr `expireTrials()` periodicamente.
- **@machize/queue** — processamento assíncrono das reações aos hooks de faturação.
