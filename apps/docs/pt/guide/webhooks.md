# Webhooks

O `@basaltkit/webhooks` entrega webhooks **de saída**: payloads assinados, retries
com backoff, subscrições por tenant e dispatch automático a partir dos teus
eventos de domínio. Três peças trabalham em conjunto — um **store** (onde vivem as
subscrições), um **deliverer** (assina e faz `POST` com retries) e um **manager**
(encontra os endpoints subscritos de um evento e entrega a cada um).

[[toc]]

## Configuração

`webhooksPlugin` regista um `WebhookManager` sob o token `WEBHOOKS`. A única opção
mais ou menos obrigatória é um `secret` de assinatura por omissão:

```ts
import { createApp } from '@basaltkit/core'
import { webhooksPlugin, WEBHOOKS } from '@basaltkit/webhooks'

const app = await createApp({
  plugins: [
    webhooksPlugin({ secret: process.env.WEBHOOK_SECRET }),
  ],
}).boot()

const hooks = app.container.get(WEBHOOKS)
```

## Gerir subscrições

Um **endpoint** é uma subscrição: um URL de destino mais os padrões de evento que
quer. Regista, lista e remove-os através do manager:

```ts
const endpoint = await hooks.register({
  url: 'https://customer.example.com/hooks',
  events: ['invoice.*', 'user.created'], // padrões: exato, prefixo `x.*`, ou `*`
  tenantId: 'acme',        // omite para receber eventos de todos os tenants (global)
  secret: 'whsec_acme_...',// secret opcional por endpoint (sobrepõe-se ao default)
  active: true,            // define false para desativar sem apagar
})

await hooks.list()          // todos os endpoints
await hooks.list('acme')    // só os endpoints do tenant "acme"
await hooks.unregister(endpoint.id)
```

Os padrões de evento correspondem assim:

- `'invoice.paid'` — apenas esse evento exato
- `'invoice.*'` — qualquer evento que comece por `invoice.`
- `'*'` — todos os eventos

```ts
import { matchesEvent } from '@basaltkit/webhooks'
matchesEvent(['invoice.*'], 'invoice.paid') // true
```

## Fazer dispatch de eventos

`dispatch(event, data, tenantId?)` encontra todos os endpoints subscritos (os do
próprio tenant mais os globais) e entrega um `POST` assinado a cada um,
devolvendo um `DeliveryResult` por endpoint:

```ts
const results = await hooks.dispatch('invoice.paid', { id: 'in_1', amount: 42 }, 'acme')
// [{ endpointId: '...', ok: true, status: 200, attempts: 1 }]
```

Cada resultado é `{ endpointId, ok, status?, attempts, error? }` — persiste-o para
um registo de auditoria.

### O que o destinatário recebe

```
content-type: application/json
x-basalt-event: invoice.paid
x-basalt-signature: t=1712345678,v1=<hmac-sha256(t.body)>

{"event":"invoice.paid","data":{"id":"in_1","amount":42},"sentAt":"2026-08-07T10:00:00.000Z"}
```

## Dispatch automático a partir de eventos de domínio

Liga o bus uma vez e os eventos de domínio correspondentes espalham-se
automaticamente pelos endpoints subscritos — restritos ao tenant a partir do
contexto do pedido e fire-and-forget, para que o emissor nunca bloqueie em HTTP.
Isto requer `@basaltkit/events`:

```ts
import { createApp } from '@basaltkit/core'
import { defineEvent, EVENTS, eventsPlugin } from '@basaltkit/events'
import { webhooksPlugin } from '@basaltkit/webhooks'

const app = await createApp({
  plugins: [
    eventsPlugin(),
    webhooksPlugin({
      secret: process.env.WEBHOOK_SECRET,
      events: ['invoice.*', 'user.created'], // eventos de domínio a reencaminhar
    }),
  ],
}).boot()

const InvoicePaid = defineEvent<{ amount: number }>('invoice.paid')
await app.container.get(EVENTS).emit(InvoicePaid, { amount: 42 })
// → entregue a todos os endpoints subscritos a "invoice.*"
```

::: warning Aviso
O dispatch automático precisa de `eventsPlugin()` registado — o plugin declara
essa dependência. O tenant vem de `ctx().tenant.id`; quando emites fora de um
pedido (ex. num job) não há tenant no contexto, por isso o evento chega apenas aos
endpoints **globais**. Faz dispatch manual com um `tenantId` explícito quando
precisares de scoping por tenant fora do caminho do pedido.
:::

## Assinatura e verificação

Cada entrega carrega `X-Basalt-Signature: t=<unix>,v1=<hmac-sha256(t.body)>` — o
mesmo esquema que a Stripe usa. Os recetores recalculam o HMAC sobre
`timestamp.body` e comparam em tempo constante, rejeitando timestamps velhos para
evitar replay:

```ts
import { verifySignature } from '@basaltkit/webhooks'

// no teu recetor, sobre o corpo RAW do pedido (não um objeto reserializado):
const valid = verifySignature(
  req.headers['x-basalt-signature'] as string,
  rawBody,
  process.env.WEBHOOK_SECRET!,
  300, // tolerância em segundos (default) — rejeita timestamps mais velhos que isto
)
if (!valid) return res.status(400).end()
```

::: warning Verifica sobre o corpo raw
O HMAC é calculado sobre os bytes exatos enviados. Se a tua framework fizer parse
do JSON e tu voltares a fazer `JSON.stringify`, os bytes mudam e a verificação
falha. Captura o corpo raw (ex. `express.raw()` no Express) antes do parse.
:::

`signPayload(body, secret, timestampSeconds)` produz o mesmo header se precisares
de assinar manualmente.

## Semântica de entrega

- Falhas transitórias (`5xx`, erros de rede, timeouts) fazem retry com backoff
  exponencial — `500ms`, `1s`, `2s`, … até `maxRetries` (default `3`).
- Erros de cliente (`4xx`) **não** são repetidos — um URL errado ou auth errada
  não se corrigem sozinhos no retry.
- Afina o deliverer através das opções do plugin (passam diretamente para o
  `WebhookDeliverer`):

```ts
webhooksPlugin({
  secret: process.env.WEBHOOK_SECRET,
  maxRetries: 5,     // retries após a primeira tentativa (default 3)
  backoffMs: 500,    // espera base, duplicada a cada tentativa (default 500)
  timeoutMs: 10_000, // timeout por tentativa (default 10s)
})
```

Para retries duráveis e distribuídos que sobrevivem a um restart a meio da
entrega, conduz `dispatch()` a partir de `@basaltkit/queue` em vez de depender do
loop de retry em processo — vê [Filas e jobs](/guide/queues).

## Stores de subscrição duráveis

O `MemoryWebhookStore` por omissão esquece cada endpoint no restart — depois de um
redeploy ninguém está subscrito e os eventos param em silêncio. Em produção,
troca por um store durável. O contrato `WebhookStore` é idêntico entre backends,
por isso é uma mudança de uma linha.

### SQLite (nó único, zero dependências)

`@basaltkit/webhooks-sqlite` persiste as subscrições num ficheiro local sobre o
`node:sqlite` embutido do Node (Node 22.5+; sem flag no Node 24).

```ts
import { webhooksPlugin } from '@basaltkit/webhooks'
import { sqliteWebhookStore } from '@basaltkit/webhooks-sqlite'

const webhooks = sqliteWebhookStore('./data/webhooks.db') // ':memory:' por omissão

webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
```

`sqliteWebhookStore()` abre (ou cria) a base de dados, aplica um schema
idempotente e devolve `{ store, db }` — o handle `db` raw fica exposto se
precisares dele.

### Prisma (Postgres/MySQL, multi-instância)

`@basaltkit/webhooks-prisma` partilha um conjunto de subscrições entre instâncias
na base de dados que já corres. Traz o teu próprio `PrismaClient`; o pacote traz
um modelo de referência.

```bash
pnpm add @basaltkit/webhooks @basaltkit/webhooks-prisma
pnpm basalt prisma:sync --push   # adiciona o modelo WebhookEndpoint + cria a tabela
```

```ts
import { webhooksPlugin } from '@basaltkit/webhooks'
import { prismaWebhookStore } from '@basaltkit/webhooks-prisma'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const webhooks = prismaWebhookStore(prisma)

webhooksPlugin({ store: webhooks.store, secret: process.env.WEBHOOK_SECRET })
```

`prisma:sync` descobre todos os pacotes `@basaltkit/*-prisma` instalados e junta
os seus modelos ao teu `schema.prisma`. Liga o store antes de o modelo existir e
ele falha logo, nomeando o modelo em falta — vê
[Persistência](/guide/persistence).

### Qual backend?

| Store | Pacote | Usar quando |
| --- | --- | --- |
| Memory | `@basaltkit/webhooks` | Dev e testes (perde-se no restart) |
| SQLite | `@basaltkit/webhooks-sqlite` | Um só nó, zero dependências, ficheiro local |
| Prisma | `@basaltkit/webhooks-prisma` | Postgres/MySQL, várias instâncias partilham subscrições |

### Escrever o teu próprio store

Implementa o contrato `WebhookStore` — quatro métodos — sobre qualquer backend:

```ts
import { type WebhookStore, type WebhookEndpoint, matchesEvent } from '@basaltkit/webhooks'

class MyWebhookStore implements WebhookStore {
  // ativos, restritos ao tenant, com padrão de evento correspondido (usa matchesEvent)
  async forEvent(event: string, tenantId?: string): Promise<WebhookEndpoint[]> { /* … */ return [] }
  async add(endpoint: Omit<WebhookEndpoint, 'id'> & { id?: string }): Promise<WebhookEndpoint> { /* … */ throw 0 }
  async remove(id: string): Promise<void> { /* … */ }
  async list(tenantId?: string): Promise<WebhookEndpoint[]> { /* … */ return [] }
}

webhooksPlugin({ store: new MyWebhookStore(), secret: process.env.WEBHOOK_SECRET })
```

## Ver também

- [Filas e jobs](/guide/queues) — conduz a entrega a partir de uma fila para
  retries duráveis.
- [Cookbook de SaaS multi-tenant](/cookbook/multi-tenant-saas) — endpoints por
  tenant numa app real.
