# Pagamentos por referência e mobile-money

[[toc]]

O Basalt tem **dois** modelos de faturação. Cartões com um portal self-service e
cobranças recorrentes com cartão em ficheiro vivem em
[Subscrições](/pt/guide/billing) (o `BillingGateway`, ex. Stripe). Este guia cobre
o **outro** modelo — **pagamentos por referência e mobile-money**, usados por toda
a Angola e por grande parte de África, onde não há cartão em ficheiro:

- **Referência** — o cliente paga uma **Referência** numérica num ATM, no
  Multicaixa Express, ou numa app de banco, citando a **Entidade** fixa da tua
  conta.
- **Push** — um pedido é enviado para o telemóvel do cliente (Multicaixa Express,
  Unitel Money…), que ele aprova.
- **Redirect** — uma página de cartão alojada.

Os três assentam num único contrato — `PaymentGateway` — por isso o teu código de
checkout e de webhook nunca muda quando trocas ou adicionas um fornecedor. Por
cima dele, o Basalt dá-te um **ledger idempotente**, **hooks de ciclo de vida**,
**stores duráveis** (Prisma / SQLite), um hot-path de deduplicação com **Redis**,
e **faturação recorrente** modelada como uma referência por período.

::: tip Dica: pacotes
`@basaltkit/subscriptions` (contrato + ledger + recorrência + helpers de
dinheiro), `@basaltkit/subscriptions-proxypay` (driver ProxyPay — pronto para
produção), `@basaltkit/subscriptions-prisma` / `-sqlite` (stores duráveis). A
faturação por cartão está em [Subscrições](/pt/guide/billing).
:::

## O dinheiro está em unidades menores — lê isto primeiro

**Todos os montantes neste ecossistema são um inteiro na unidade menor da moeda**
(cêntimos; `100` = `1.00`). Esta é a convenção do Stripe/Adyen: exata, sem
arredondamento de vírgula flutuante, sem ambiguidade quanto às unidades.

```ts
import { toMinor, toMajor, formatMoney, assertMinorUnits } from '@basaltkit/subscriptions'

toMinor(5000, 'AOA')   // 500000   — 5.000,00 Kz em unidades menores
toMinor(29.99, 'USD')  // 2999     — $29.99
toMajor(500000, 'AOA') // 5000
formatMoney(2999, 'USD', 'en-US') // "$29.99"
assertMinorUnits(2999) // ok
assertMinorUnits(29.99) // lança RangeError — um deslize de unidade maior falha depressa
```

::: warning Aviso: na tua fronteira HTTP / UI
Os humanos pensam em Kwanzas, não em centavos. Converte na borda:
`toMinor(amount, 'AOA')` à entrada, `toMajor` / `formatMoney` à saída. Tudo o que
está no meio — gateways, ledger, stores — permanece em unidades menores.
:::

## A arquitetura de relance

```
                       ┌─────────────────────────────────────────┐
  createPayment(req) ─▶│ PaymentGateway  (ProxyPay / AppyPay / …) │◀─ verifyWebhook(raw, sig)
                       └─────────────────────────────────────────┘
                                        │  PaymentInstruction / PaymentEvent
                                        ▼
                       ┌─────────────────────────────────────────┐
                       │ PaymentLedger                           │
                       │  • regista pagamentos (pending → paid)  │──▶ PaymentStore (Prisma / SQLite)
                       │  • apply idempotente (dedupe por event.id)│──▶ WebhookStore (Redis / SQL)
                       │  • hooks de ciclo de vida (recorded/confirmed) │
                       └─────────────────────────────────────────┘
                                        ▲
                       ┌─────────────────────────────────────────┐
                       │ RecurringReferenceBilling               │
                       │  uma referência por período → paidThrough │──▶ RecurringStore (Prisma / SQLite)
                       └─────────────────────────────────────────┘
```

## Instalar

```bash
pnpm add @basaltkit/subscriptions @basaltkit/subscriptions-proxypay
# stores duráveis — escolhe uma:
pnpm add @basaltkit/subscriptions-prisma   # Postgres / MySQL / SQLite via Prisma
pnpm add @basaltkit/subscriptions-sqlite   # node:sqlite, zero dependências
```

## O contrato `PaymentGateway`

Tudo é expresso em três formas e uma interface.

```ts
interface PaymentRequest {
  billableId: string          // quem paga — reconcilias contra isto
  amount: number              // unidades MENORES (inteiro)
  currency?: string           // ISO 4217; predefine para a própria da gateway (AOA)
  reference?: string          // o teu id de encomenda/fatura
  description?: string
  customer?: { name?: string; email?: string; phone?: string }
  expiresAt?: number          // epoch ms — quando a referência deixa de ser pagável
  metadata?: Record<string, string> // ecoado de volta no webhook
}

interface PaymentInstruction {
  id: string                  // o id de pagamento da gateway (para reconciliação)
  status: 'pending' | 'paid' | 'failed'
  reference?: { entity: string; reference: string; amount: number } // Multicaixa
  url?: string                // redirect alojado
  push?: { phone: string }    // foi enviado um pedido para este telefone
  raw?: unknown
}

interface PaymentEvent {
  id: string                  // id de evento único da gateway — para idempotência
  type: 'payment.succeeded' | 'payment.failed'
  paymentId: string           // corresponde a PaymentInstruction.id
  amount: number              // unidades MENORES
  billableId?: string
  reference?: string
  raw?: unknown
}

interface PaymentGateway {
  readonly name: string
  createPayment(request: PaymentRequest): Promise<PaymentInstruction>
  verifyWebhook(rawBody: string, signature: string | undefined): PaymentEvent | null
  getPayment?(id: string): Promise<PaymentInstruction>
}
```

Para testes, `FakePaymentGateway` é um driver em processo — sem rede:

```ts
import { FakePaymentGateway } from '@basaltkit/subscriptions'

const gw = new FakePaymentGateway()
const inst = await gw.createPayment({ billableId: 'acme', amount: 500000 })
// verifyWebhook aceita signature === 'valid' e parseia o corpo como um PaymentEvent
```

## 1 · Criar um pagamento (ProxyPay)

```ts
import { ProxyPayGateway } from '@basaltkit/subscriptions-proxypay'

const payments = new ProxyPayGateway({
  apiKey: process.env.PROXYPAY_API_KEY!, // Authorization: Token <key>
  entity: process.env.PROXYPAY_ENTITY!,  // a tua Entidade Multicaixa
  sandbox: process.env.NODE_ENV !== 'production',
  // webhookSecret predefine para a API key (o que o ProxyPay usa para assinar); '' desativa.
})

const inst = await payments.createPayment({
  billableId: 'tenant_42',
  amount: 500000,            // 5.000,00 Kz em unidades menores
  description: 'Plano Pro — Agosto',
})

// inst.reference = { entity: '00362', reference: '739365427', amount: 500000 }
// Mostra ao cliente: Entidade 00362 · Referência 739365427 · 5.000,00 Kz
```

O ProxyPay **exige uma validade** e uma referência numérica. O driver trata de
ambas: envia sempre `end_datetime` (a partir de `expiresAt` ou da opção
`expiryDays`, predefinição 30), e reserva uma referência numérica a menos que
passes uma `reference` numérica tua. Uma `reference` não numérica (ex. um id de
encomenda) é guardada em `custom_fields` enquanto o ProxyPay atribui a numérica.

### Opções do ProxyPay

| Opção | Predefinição | Notas |
| --- | --- | --- |
| `apiKey` | — | Enviado como `Authorization: Token <key>` |
| `entity` | — | A tua Entidade Multicaixa (Entidade) |
| `sandbox` | `false` | Usa o host de sandbox |
| `baseUrl` | prod/sandbox | Substitui o host por completo |
| `webhookSecret` | `apiKey` | Segredo HMAC; `''` para desativar a verificação |
| `callbackUrl` | — | Ecoado como `custom_fields.callback_url` por referência |
| `expiryDays` | `30` | Validade de fallback quando `expiresAt` é omitido |
| `fetch` | `fetch` global | Cliente HTTP injetável |

## 2 · Receber o webhook

Quando uma referência é paga, o ProxyPay faz `POST` de um corpo JSON **plano**
(`reference_id`, `amount`, `id`, `custom_fields` ao nível de topo) assinado com
**HMAC-SHA256** no cabeçalho **`x-signature`**. `verifyWebhook` valida-o e devolve
um `PaymentEvent`.

```ts
import { route } from '@basaltkit/http'

route({
  method: 'POST',
  url: '/webhooks/proxypay',
  async handler({ request, reply }) {
    const raw = rawBody(request)            // os bytes EXATOS — vê o aviso abaixo
    const sig = request.headers['x-signature']
    let event
    try {
      event = payments.verifyWebhook(raw, Array.isArray(sig) ? sig[0] : sig)
    } catch {
      return reply.code(400).send({ error: 'invalid signature' }) // WebhookInvalidError
    }
    if (event?.type === 'payment.succeeded') {
      await activate(event.billableId!, event.paymentId)
    }
    return reply.code(200).send({ ok: true }) // sempre 200 para o ProxyPay marcar como entregue
  },
})
```

::: warning Aviso: assina sobre o corpo bruto
O HMAC é calculado sobre os **bytes exatos** que o ProxyPay enviou. A maioria dos
parsers de JSON descarta-os. Duas opções seguras: captura o corpo bruto do pedido
(um plugin `rawBody`), ou re-serializa o corpo parseado — `JSON.stringify(request.body)`
é byte-idêntico para o JSON compacto e de chaves estáveis do ProxyPay (verificado
contra callbacks reais), e é o que faz uma integração de produção comprovadamente
boa.
:::

`verifyWebhook` devolve `null` para tudo o que não seja um pagamento (sem
`reference_id`), por isso podes passar cada callback por ele com segurança.

## 3 · O ledger de pagamentos — idempotência, registos, hooks

O `createPayment` + `verifyWebhook` em bruto funcionam, mas todas as apps reais
precisam depois das mesmas três coisas: **guardar** o pagamento, aplicar o webhook
**exatamente uma vez** (as gateways fazem retentativas), e **reagir** às
confirmações. `PaymentLedger` é essa camada.

```ts
import { PaymentLedger } from '@basaltkit/subscriptions'

const ledger = new PaymentLedger() // em memória por predefinição; passa { store, webhooks } para durável

// no checkout — regista-o como pending
const inst = await payments.createPayment(request)
await ledger.created(inst, request)

// na rota do webhook — aplica-o exatamente uma vez
const event = payments.verifyWebhook(raw, sig)
if (event) {
  const { fresh, record } = await ledger.apply(event)
  // fresh === false → um callback duplicado; já o trataste
}

// lê o status atual (para uma UI de polling)
const rec = await ledger.get(reference) // { id, status, amount, createdAt, updatedAt, ... }
```

### Idempotência

`apply` reclama `event.id` num `WebhookStore` antes de fazer o que quer que seja.
Um callback repetido devolve `{ fresh: false }` e não altera nada. Se a
persistência lançar, a reclamação é **libertada** para que a retentativa da
gateway possa reprocessar.

### Efeitos secundários de domínio atómicos

Passa um callback `onFresh` para correr **dentro** da reclamação de idempotência
— para um efeito secundário que tem de se aplicar exatamente uma vez com o
pagamento (ativar uma subscrição, marcar uma reserva como paga). Se lançar, tudo é
libertado e retentado.

```ts
await ledger.apply(event, async (record, event) => {
  await bookings.markPaid(record!.reference!) // atómico com o pagamento
})
```

### Hooks de ciclo de vida

Para efeitos secundários de **melhor esforço** (notificações, analytics) que nunca
devem reverter um pagamento, subscreve com `on(...)`. Os listeners correm *depois*
de o pagamento estar persistido em segurança, disparam apenas num apply **fresh**,
e um que lance é reportado via `onListenerError` — nunca revertido.

```ts
const ledger = new PaymentLedger({
  store, webhooks,
  onListenerError: (err, event) => log.error({ err, event }, 'payment listener failed'),
})

ledger.on('recorded',  ({ payment }) => analytics.track('payment_started', payment))
const off = ledger.on('confirmed', async ({ record, event }) => {
  await email.send(record!.billableId!, 'Pagamento confirmado')
})
ledger.on('failed', ({ event }) => log.warn({ event }, 'payment failed'))
// off() para cancelar a subscrição
```

| Evento | Dispara | Payload |
| --- | --- | --- |
| `recorded` | `created()` | `{ record, payment }` |
| `confirmed` | `apply` fresh de `payment.succeeded` | `{ record, event }` |
| `failed` | `apply` fresh de `payment.failed` | `{ record, event }` |

## 4 · Stores duráveis

Em produção o ledger é suportado pela tua base de dados. Dois contratos —
`PaymentStore` (o ledger) e `WebhookStore` (as reclamações de deduplicação) — com
implementações drop-in.

### Prisma (Postgres / MySQL)

Copia os modelos `Payment` + `RecurringSubscription` de
`@basaltkit/subscriptions-prisma/prisma/schema.prisma` para o teu schema
(`prisma generate`), e depois:

```ts
import { PaymentLedger } from '@basaltkit/subscriptions'
import { prismaPaymentStores, PrismaWebhookStore } from '@basaltkit/subscriptions-prisma'

const stores = prismaPaymentStores(prisma) // { payments, recurring }

const ledger = new PaymentLedger({
  store: stores.payments,
  webhooks: new PrismaWebhookStore(prisma), // dedupe via a tabela webhook_events
})
```

O dinheiro é guardado como **`BigInt`** (unidades menores) para evitar o teto de
32 bits do `Int`; `create` é um insert atómico `skipDuplicates` e `setStatus`/`save`
recorrem a um update numa violação de unicidade concorrente (P2002) — seguro sob
carga.

### SQLite (`node:sqlite`)

A mesma interface, zero dependências externas (Node 22.5+ / 24):

```ts
import { sqlitePaymentStores } from '@basaltkit/subscriptions-sqlite'

const stores = sqlitePaymentStores('./data/billing.db') // { db, payments, recurring }
const ledger = new PaymentLedger({ store: stores.payments /* webhooks predefinem para memória */ })
```

### O hot-path de Redis (recomendado à escala)

A deduplicação de webhooks é uma operação **minúscula e de alta frequência** — a
carga de trabalho ideal para Redis. Mantém o ledger (fonte da verdade) em SQL e
move a **deduplicação** para o `SET NX` do Redis com um TTL. Esta é a topologia de
produção recomendada.

```ts
import { RedisWebhookStore } from '@basaltkit/subscriptions'
import { Redis } from 'ioredis'

const redis = new Redis(process.env.REDIS_URL!)

const ledger = new PaymentLedger({
  store: prismaPaymentStores(prisma).payments,       // ledger  → Postgres (durável)
  webhooks: new RedisWebhookStore(redis, { ttlSeconds: 7 * 24 * 3600 }), // dedupe → Redis
})
```

`RedisWebhookStore` usa um `SET key value NX EX` atómico — a reclamação tem
sucesso para exatamente um chamador entre instâncias, e o TTL expira
automaticamente as reclamações antigas para que o keyspace nunca cresça sem
limites.

| Backend | Ledger | Dedupe | Quando |
| --- | --- | --- | --- |
| `subscriptions-sqlite` | ✅ | ✅ | Nó único, zero dependências |
| `subscriptions-prisma` | ✅ | ✅ | Postgres / MySQL |
| `RedisWebhookStore` | — | ✅ | Deduplicação de alto débito (emparelha com um ledger SQL) |

## 5 · Faturação recorrente (sem cartão em ficheiro)

As gateways por referência não conseguem cobrar um cartão guardado, por isso uma
subscrição é modelada como **uma referência por período**: emite uma referência a
cada período; quando o seu webhook confirma, estende o `paidThrough` da subscrição
por um intervalo. `RecurringReferenceBilling` coordena tudo.

```ts
import { RecurringReferenceBilling } from '@basaltkit/subscriptions'

const billing = new RecurringReferenceBilling({
  gateway: payments,            // a tua PaymentGateway
  ledger,                       // o PaymentLedger acima (partilhado → idempotência)
  store: stores.recurring,      // RecurringStore (Prisma / SQLite)
  leadDays: 5,                  // fica "due" estes dias antes do fim do período
})

// Subscribe → emite a primeira referência a pagar
const { subscription, instruction } = await billing.subscribe({
  billableId: 'tenant_42',
  plan: 'pro',
  amount: 250000,               // 2.500,00 Kz por período (unidades menores)
  interval: 'monthly',          // 'monthly' | 'yearly'
})

// Na rota do webhook — aplica o evento; uma referência paga estende paidThrough
const event = payments.verifyWebhook(raw, sig)
if (event) {
  const { applied, subscription } = await billing.handleEvent(event)
}

// Num agendamento (cron / um timer): emite a próxima referência para subscrições due
for (const sub of await billing.due()) {
  const next = await billing.issueNext(sub.billableId) // envia next.reference por email ao cliente
}
```

`handleEvent` é o único ponto de entrada para o webhook — aplica o ledger
(idempotentemente) **e** estende a subscrição correspondente. Pagamentos avulsos
não recorrentes passam por ele sem problema (registados, sem tocar em nenhuma
subscrição).

| Método | Faz |
| --- | --- |
| `subscribe(input)` | Cria a subscrição + emite a primeira referência |
| `issueNext(billableId)` | Emite a referência do período seguinte |
| `handleEvent(event)` | Aplica uma vez; estende `paidThrough` em sucesso, `past_due` em falha |
| `due(now?)` | Subscrições que precisam da próxima referência (dentro de `leadDays`) |
| `get` / `cancel` | Lê / cancela uma subscrição |

::: tip Dica: agendamento
Corre `due()` → `issueNext()` a partir de um cron job, de um job de
[fila](/pt/guide/queues) repetível, ou de um simples `setInterval` no `boot` de um
plugin. Mantém o intervalo bem acima do rate limit da tua gateway.
:::

## Exemplo completo — ligar tudo

Um plugin autossuficiente que regista a gateway, um ledger durável com
deduplicação em Redis, faturação recorrente, e um hook de confirmação.

```ts
import { createToken, definePlugin } from '@basaltkit/core'
import { PaymentLedger, RecurringReferenceBilling, RedisWebhookStore } from '@basaltkit/subscriptions'
import { prismaPaymentStores } from '@basaltkit/subscriptions-prisma'
import { ProxyPayGateway } from '@basaltkit/subscriptions-proxypay'
import { Redis } from 'ioredis'
import type { PrismaClient } from '@prisma/client'

export const LEDGER = createToken<PaymentLedger>('app:ledger')
export const BILLING = createToken<RecurringReferenceBilling>('app:billing')

export function paymentsPlugin(prisma: PrismaClient, redis: Redis) {
  const stores = prismaPaymentStores(prisma)
  const gateway = new ProxyPayGateway({
    apiKey: process.env.PROXYPAY_API_KEY!,
    entity: process.env.PROXYPAY_ENTITY!,
  })
  const ledger = new PaymentLedger({
    store: stores.payments,
    webhooks: new RedisWebhookStore(redis),
  })
  const billing = new RecurringReferenceBilling({ gateway, ledger, store: stores.recurring })

  return definePlugin({
    name: 'app:payments',
    register({ container }) {
      container.singleton(LEDGER, () => ledger)
      container.singleton(BILLING, () => billing)
    },
    boot() {
      // um único sítio para reagir a cada pagamento confirmado (avulso ou recorrente)
      ledger.on('confirmed', async ({ event }) => {
        // notificar, faturar, analytics…
      })
    },
  })
}
```

## Fornecedores

| Fornecedor | Pacote | Estado |
| --- | --- | --- |
| **ProxyPay** (referências Multicaixa) | `@basaltkit/subscriptions-proxypay` | Pronto para produção, validado contra a API em produção |
| **AppyPay** (push Express, referências, cartões) | `@basaltkit/subscriptions-appypay` | **Pré-lançamento** — detalhes de ligação pendentes de validação em sandbox |

### Escrever o teu próprio driver

Implementa `PaymentGateway`. Traduz para o formato do teu fornecedor em
`createPayment`, e o seu webhook para um `PaymentEvent` em `verifyWebhook`
(devolvendo `null` para tudo o que não seja um pagamento, lançando
`WebhookInvalidError` numa assinatura má). **Os montantes chegam em unidades
menores** — converte para o formato do fornecedor com `toMajor`, e de volta com
`toMinor`:

```ts
import { assertMinorUnits, toMajor, toMinor, WebhookInvalidError } from '@basaltkit/subscriptions'

class MyGateway implements PaymentGateway {
  readonly name = 'my-provider'
  async createPayment(req: PaymentRequest): Promise<PaymentInstruction> {
    assertMinorUnits(req.amount)
    const providerAmount = toMajor(req.amount, req.currency ?? 'AOA') // ex. 500000 → 5000.00
    // …chama o fornecedor, mapeia a resposta…
    return { id, status: 'pending', reference: { entity, reference, amount: req.amount } }
  }
  verifyWebhook(raw: string, sig: string | undefined): PaymentEvent | null {
    // …verifica sig ou lança WebhookInvalidError; devolve null se não for um pagamento…
    return { id, type: 'payment.succeeded', paymentId, amount: toMinor(providerAmount, 'AOA') }
  }
}
```

## Erros

| Erro | Significado |
| --- | --- |
| `WebhookInvalidError` | A verificação da assinatura falhou — responde `400` |
| `ProxyPayRequestError` | Uma chamada à API do ProxyPay falhou; carrega `httpStatus` |
| `RangeError` (de `assertMinorUnits`) | Um montante não era um inteiro não negativo em unidades menores |

## Ver também

- [Subscrições](/pt/guide/billing) — faturação por cartão, planos, trials, limites de funcionalidades
- [Webhooks](/pt/guide/webhooks) — o guia geral de entrega/verificação de webhooks
- [Persistência e stores duráveis](/pt/guide/persistence) — o padrão de store em todo o Basalt
