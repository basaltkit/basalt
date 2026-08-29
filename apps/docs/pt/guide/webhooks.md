# Webhooks

O `@basaltkit/webhooks` entrega webhooks **de saída**: payloads assinados, retries
com backoff, subscrições por tenant e dispatch automático a partir dos teus
eventos de domínio. Está desacoplado do teu domínio — nada no teu código precisa
de saber que existe um endpoint — e do transporte, porque a entrega é um simples
`POST` assinado que qualquer recetor consegue verificar.

[[toc]]

## Modelo mental

Três peças, cada uma substituível:

| Peça | Contrato | O que faz |
| --- | --- | --- |
| **Store** | `WebhookStore` | Onde vivem as subscrições. Responde a "quem quer `invoice.paid` do tenant `acme`?" |
| **Deliverer** | `WebhookDeliverer` | Assina o corpo, valida o URL contra SSRF, faz `POST` e repete falhas transitórias |
| **Manager** | `WebhookManager` (token `WEBHOOKS`) | Regista/lista/remove endpoints e faz `dispatch(event, data)` a todos os que correspondem |

O `dispatch` é o fluxo inteiro: o manager pede ao store os endpoints que
correspondem ao evento *e* ao tenant, entrega cada um ao deliverer e devolve um
`DeliveryResult` por endpoint. Nada é persistido sobre a tentativa — se precisares
de um registo de auditoria, guarda os resultados tu; se precisares que a entrega
sobreviva a um crash, usa o outbox (abaixo).

O scoping por tenant é **anti-alargamento** em todo o lado: um `ctx().tenant.id`
ambiente ganha sempre a um `tenantId` passado pelo chamador, por isso o input do
cliente nunca consegue alargar nem trocar o âmbito.

## Arranque rápido

`webhooksPlugin` regista um `WebhookManager` sob o token `WEBHOOKS`. A única
opção quase obrigatória é um `secret` de assinatura por predefinição:

```ts
import { createApp } from '@basaltkit/core'
import { webhooksPlugin, WEBHOOKS } from '@basaltkit/webhooks'

const app = await createApp({
  plugins: [
    webhooksPlugin({ secret: process.env.WEBHOOK_SECRET }),
  ],
}).boot()

const hooks = app.container.get(WEBHOOKS)

await hooks.register({ url: 'https://customer.example.com/hooks', events: ['invoice.*'] })
await hooks.dispatch('invoice.paid', { id: 'in_1', amount: 42 })
```

Sem um `secret` (e sem um por endpoint) as entregas saem **sem assinatura** —
nenhum header `x-basalt-signature`, por isso os recetores não têm forma de
distinguir a tua chamada da de qualquer outro. Define-o.

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

await hooks.list()          // todos os endpoints (sem tenant no contexto)
await hooks.list('acme')    // só os endpoints do tenant "acme"
await hooks.unregister(endpoint.id)
```

O scoping é **anti-alargamento**: dentro de um pedido com tenant no contexto,
`register`, `list`, `unregister` e `dispatch` ficam forçados a esse tenant — um
`tenantId` passado pelo chamador (que pode transportar input do cliente) nunca
consegue alargar ou trocar o âmbito. O argumento explícito e o comportamento
system-wide acima aplicam-se apenas onde não há tenant ambiente (jobs, CLI, apps
single-tenant). `unregister` é um no-op — não um erro — para um endpoint que
pertence a outro tenant.

Os padrões de evento correspondem assim:

- `'invoice.paid'` — apenas esse evento exato
- `'invoice.*'` — qualquer evento que comece por `invoice.`
- `'*'` ou `'**'` — todos os eventos

```ts
import { matchesEvent } from '@basaltkit/webhooks'
matchesEvent(['invoice.*'], 'invoice.paid') // true
```

Só endpoints com `active !== false` recebem entregas; pôr `active` a `false` é a
forma reversível de travar um endpoint de cliente instável.

## Fazer dispatch de eventos

`dispatch(event, data, tenantId?)` encontra todos os endpoints subscritos (os do
próprio tenant mais os globais) e entrega um `POST` assinado a cada um,
devolvendo um `DeliveryResult` por endpoint:

```ts
const results = await hooks.dispatch('invoice.paid', { id: 'in_1', amount: 42 }, 'acme')
// [{ endpointId: '...', ok: true, status: 200, attempts: 1 }]
```

Cada resultado é `{ endpointId, ok, status?, attempts, error? }` — persiste-o
para um registo de auditoria. As entregas correm em paralelo e o `dispatch` só
resolve quando todas terminam, por isso um endpoint que gasta todo o orçamento de
retries atrasa a chamada inteira: faz `dispatch` a partir de um job ou do outbox,
não inline num handler de pedido.

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
essa dependência quando `events` não está vazio. O tenant vem de
`ctx().tenant.id`; quando emites fora de um pedido (ex. num job) não há tenant no
contexto, por isso o evento chega apenas aos endpoints **globais**. Faz dispatch
manual com um `tenantId` explícito quando precisares de scoping por tenant fora
do caminho do pedido.
:::

Fire-and-forget também quer dizer **silencioso**: o listener faz
`void dispatch(...)`, por isso uma entrega falhada nunca chega ao emissor e nada
volta a tentar depois de gasto o orçamento em processo. É essa a troca — vê o
outbox abaixo quando perder um evento não for aceitável.

## Eventos de integração duráveis (outbox)

O auto-dispatch acima é **fire-and-forget** — uma entrega falhada ou um crash
entre "committed" e "delivered" perde o evento. Para entrega garantida usa o
**outbox**: os eventos de domínio são primeiro escritos num store transacional e
depois um relay publica-os aos subscritores com retries (**at-least-once**).
Requer o `eventsPlugin`.

```ts
import { webhooksPlugin, webhookOutboxPlugin, webhookOutboxDispatch, WEBHOOKS } from '@basaltkit/webhooks'
import { eventsPlugin, OUTBOX } from '@basaltkit/events'

createApp({
  plugins: [
    eventsPlugin(),
    webhooksPlugin({ store }),               // sem `events:` aqui — o outbox captura-os
    webhookOutboxPlugin({
      events: ['invoice.*', 'user.created'], // padrões a capturar (default '**')
      // store: new MyDurableOutboxStore(),  // durável em produção (default em memória)
      intervalMs: 5000,                      // poll do relay; 0 = flush manual via OUTBOX
      batchSize: 50,                         // entradas por flush
      maxAttempts: 10,                       // depois a entrada fica morta
    }),
  ],
})
```

O `webhookOutboxDispatch` só trata uma entrada como entregue quando **todos** os
endpoints subscritos a aceitaram; uma falha lança, por isso a entrada inteira é
repetida contra todos eles. Os subscritores têm portanto de ser **idempotentes** —
o payload leva o nome do evento e os dados para dedup. Resolve o token `OUTBOX`
para fazer o relay tu mesmo, ex. a partir de um worker de fila em vez do timer:

```ts
await container.get(OUTBOX).flush(webhookOutboxDispatch(container.get(WEBHOOKS)))
```

Suporta o outbox com um `OutboxStore` durável (a tua BD) para não perder nada
entre reinícios — o objetivo do padrão. Vê [Persistência](/pt/guide/persistence).

### Entradas mortas e falhas de flush

Duas falhas diferentes, tratadas em dois sítios diferentes:

- Uma **falha de dispatch por entrada** incrementa os `attempts` da entrada e
  regista `lastError`, depois faz backoff (exponencial a partir de 1 s, com teto
  de 60 s, contabilizado por processo de relay). Ao fim de `maxAttempts`
  (predefinição 10) a entrada fica **morta**: mantém-se no store com o seu
  `lastError` e nunca mais é enviada. O callback `onDead` do `Outbox` dispara uma
  vez — por predefinição escreve em `console.error`, porque um evento de
  integração silenciosamente perdido é o pior resultado possível.
- Uma **falha ao nível do flush** (o próprio `pending()` do store lança) não é um
  problema da entrada. O `onFlushError` do `outboxPlugin` existe para isso.

::: warning O `webhookOutboxPlugin` não expõe `onDead` / `onFlushError`
As suas opções são exatamente `store`, `events`, `intervalMs`, `batchSize` e
`maxAttempts` — só reencaminha `maxAttempts` para o `Outbox` que constrói, por
isso as entradas mortas vão para `console.error` e uma falha de flush ao nível do
store surge como uma rejeição não tratada em vez de um callback. Quando
precisares de ser alertado por um evento morto, liga o outbox tu mesmo com o
`outboxPlugin` de `@basaltkit/events` e o `webhookOutboxDispatch` como `dispatch`:
:::

```ts
import { eventsPlugin, outboxPlugin } from '@basaltkit/events'
import {
  WebhookDeliverer,
  WebhookManager,
  webhookOutboxDispatch,
  webhooksPlugin,
} from '@basaltkit/webhooks'

const deliverer = new WebhookDeliverer({ secret: process.env.WEBHOOK_SECRET })
const webhooks = new WebhookManager(store, deliverer) // `store` é o teu WebhookStore

createApp({
  plugins: [
    eventsPlugin(),
    webhooksPlugin({ store, deliverer }), // o token WEBHOOKS recebe as mesmas peças
    outboxPlugin({
      store: outboxStore,
      captureEvents: ['invoice.*', 'user.created'],
      intervalMs: 5000,
      dispatch: webhookOutboxDispatch(webhooks),
      maxAttempts: 10,
      onDead: (entry, error) => pager.page(`webhook outbox dead: ${entry.event}`, error),
      onFlushError: (error) => logger.error({ error }, 'outbox flush failed'),
    }),
  ],
})
```

Regista **um** dos dois — ambos reclamam o token `OUTBOX`.

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
de assinar manualmente. `verifySignature` devolve `false` — nunca lança — para um
header malformado, um `v1` em falta, um timestamp fora da tolerância ou um digest
diferente, por isso um recetor pode tratá-lo como um único booleano.

## Semântica de entrega

- Falhas transitórias (`5xx`, erros de rede, timeouts) fazem retry com backoff
  exponencial — `500ms`, `1s`, `2s`, … até `maxRetries` (default `3`, ou seja
  quatro tentativas no total).
- Erros de cliente (`4xx`) **não** são repetidos — um URL errado ou auth errada
  não se corrigem sozinhos no retry. O resultado leva `error: 'HTTP 404'`.
- Os redirecionamentos são **recusados, não seguidos**: um `3xx` termina a
  entrega com `error: 'redirect refused'`. Segui-lo permitiria que um URL público
  e conforme desviasse o pedido para um endereço interno.
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
loop de retry em processo — vê [Filas e jobs](/pt/guide/queues).

### A guarda SSRF

Os URLs dos endpoints são fornecidos por clientes, por isso cada URL de entrega é
tratado como input hostil. Antes da primeira tentativa o deliverer resolve o
hostname **uma vez** e recusa a entrega se o esquema não for `http:`/`https:`, ou
se *algum* endereço resolvido for loopback, privado (`10/8`, `172.16/12`,
`192.168/16`), link-local (incluindo o endereço de metadados de cloud
`169.254.169.254`), CGNAT, ULA IPv6, ou de outra forma reservado.

O socket é depois **fixado** ao endereço que foi validado, para que um DNS
autoritativo hostil não possa devolver um IP público à verificação e um IP
interno no momento da ligação (DNS rebinding). O header `Host` e o SNI de TLS
continuam a levar o hostname original, por isso vhosts e validação de certificado
não são afetados.

Um URL bloqueado é um erro permanente de configuração, não transitório: o
resultado é `{ ok: false, attempts: 0, error: 'Refusing to deliver webhook to …' }`
e nada é repetido.

```ts
// Instalação self-hosted que tem mesmo de entregar a um host interno:
webhooksPlugin({ secret, ssrf: { allowPrivateHosts: true } })

// Só HTTPS (recusa endpoints http:// na entrega):
webhooksPlugin({ secret, ssrf: { allowedSchemes: ['https:'] } })

// Desligar a guarda por completo — não faças isto, a menos que todos os URLs sejam teus:
webhooksPlugin({ secret, ssrf: false })
```

`allowPrivateHosts: true` salta a validação **e** a fixação, para que o resolver
do próprio operador seja respeitado no momento da ligação. O
`assertDeliverableUrl(url)` é exportado se quiseres rejeitar um URL mau no momento
do registo — com um erro claro para o cliente — em vez de na primeira entrega.

## Expor a gestão de endpoints por HTTP

O pacote não traz **nenhuma rota HTTP**: quem pode gerir os endpoints de um
tenant é uma decisão da app, e é uma decisão privilegiada (um endpoint é uma
exportação de dados para fora). Constrói-as sobre o `route()` neutro para que
sirvam de forma idêntica em Fastify, Express e Hono:

```ts
import { route } from '@basaltkit/http'
import { ctx, type Container } from '@basaltkit/core'
import { WEBHOOKS } from '@basaltkit/webhooks'
import { z } from 'zod'

const hooks = () => (ctx().container as Container).get(WEBHOOKS)

export const webhookRoutes = () => [
  route({
    method: 'GET',
    url: '/webhooks/endpoints',
    meta: { auth: true, teamRole: 'admin' },
    async handler() { return { data: await hooks().list() } },
  }),
  route({
    method: 'POST',
    url: '/webhooks/endpoints',
    meta: { auth: true, teamRole: 'admin' },
    body: z.object({ url: z.string().url(), events: z.array(z.string()).min(1) }),
    async handler({ body, reply }) {
      // o tenantId é forçado a partir de ctx() — nunca o leias do corpo
      return reply.code(201).send(await hooks().register(body))
    },
  }),
]
```

`meta.teamRole` precisa do [`teamsPlugin`](/pt/guide/teams); `meta.auth` precisa
do `authPlugin`. Declarar qualquer um deles sem o respetivo plugin recusa
arrancar com `UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`) em vez de
servir a rota sem guarda — vê o [guia de adaptadores](/pt/guide/adapters).

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
[Persistência](/pt/guide/persistence).

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
  // quando tenantId é dado, remove SÓ se esse tenant for dono do endpoint
  async remove(id: string, tenantId?: string): Promise<void> { /* … */ }
  async list(tenantId?: string): Promise<WebhookEndpoint[]> { /* … */ return [] }
}

webhooksPlugin({ store: new MyWebhookStore(), secret: process.env.WEBHOOK_SECRET })
```

Duas regras que o store embutido segue e o teu também tem de seguir: `forEvent`
devolve endpoints cujo `tenantId` corresponde **ou é undefined** (os endpoints
globais recebem tudo), e ignora os que têm `active: false`. `remove(id, tenantId)`
tem de ser um no-op silencioso quando o endpoint pertence a outra pessoa — é isso
que torna o âmbito anti-alargamento seguro.

## Referência de opções

### `webhooksPlugin(options)`

Tudo exceto `store`, `deliverer` e `events` é reencaminhado para o
`WebhookDeliverer` que constrói (e ignorado se passares o teu próprio
`deliverer`).

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `store` | `WebhookStore` | `MemoryWebhookStore` | Onde vivem as subscrições — troca por `webhooks-sqlite`/`webhooks-prisma`, ou os endpoints desaparecem no restart |
| `deliverer` | `WebhookDeliverer` | construído a partir destas opções | Traz o teu (partilhado com um relay de outbox, ou um duplo de teste) |
| `events` | `string[]` | `[]` (desligado) | Padrões de eventos de domínio a auto-despachar. Não vazio faz o plugin depender de `basalt:events` |
| `secret` | `string` | — | Secret HMAC de assinatura por predefinição. Sem ele (e sem um `secret` por endpoint) as entregas vão **sem assinatura** |
| `maxRetries` | `number` | `3` | Retries **depois** da primeira tentativa; só `5xx`/rede/timeout são repetidos |
| `backoffMs` | `number` | `500` | Espera base, duplicada por tentativa (500 ms, 1 s, 2 s, …) |
| `timeoutMs` | `number` | `10_000` | Timeout por tentativa; um abort conta como falha transitória |
| `ssrf` | `SsrfGuardOptions \| false` | ligado | A guarda do URL de entrega (abaixo). `false` desliga-a por completo |
| `fetchImpl` | `typeof fetch` | transporte fixado embutido | Cliente HTTP injetado; recebe o endereço validado no objeto init sob o símbolo exportado `PINNED_ADDRESS` |
| `sleep` | `(ms) => Promise<void>` | `setTimeout` | Sleep de backoff injetável (testes) |
| `now` | `() => number` | `Date.now()/1000` | Relógio injetável em **segundos**, usado no timestamp da assinatura |

### `SsrfGuardOptions` (a opção `ssrf`)

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `allowPrivateHosts` | `boolean` | `false` | Entrega self-hosted de confiança a hosts internos. Salta a validação **e** a fixação do endereço |
| `allowedSchemes` | `string[]` | `['https:', 'http:']` | Esquemas de URL permitidos — restringe a `['https:']` para recusar endpoints em texto simples |
| `lookup` | `(host) => Promise<{ address, family? }[]>` | `dns.lookup(host, { all: true })` | Resolver injetado (testes) |

### `webhookOutboxPlugin(options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `store` | `OutboxStore` | `MemoryOutboxStore` | Outbox durável — em memória derrota todo o propósito do padrão |
| `events` | `string[]` | `['**']` (todos) | Padrões de eventos de domínio capturados para o outbox |
| `intervalMs` | `number` | `5000` | Intervalo de poll do relay. `0` desliga o timer — faz relay manual através de `OUTBOX` |
| `batchSize` | `number` | `50` | Entradas entregues por flush |
| `maxAttempts` | `number` | `10` | Tentativas antes de a entrada ficar morta (nunca mais enviada) |

Não há `onDead` / `onFlushError` aqui — usa o `outboxPlugin` de
`@basaltkit/events` quando precisares deles, como mostrado acima. O plugin
depende de `basalt:webhooks` e de `basalt:events`, e drena o outbox uma vez no
shutdown (best-effort).

### Helpers de assinatura e SSRF

| Export | Assinatura | Porquê |
| --- | --- | --- |
| `signPayload` | `(body, secret, timestampSeconds) => string` | Constrói `t=…,v1=…` — assina um payload à mão |
| `verifySignature` | `(header, body, secret, toleranceSeconds = 300, nowSeconds?) => boolean` | Verificação em tempo constante num recetor; nunca lança |
| `assertDeliverableUrl` | `(url, options?) => Promise<void>` | Rejeita um URL inseguro para SSRF no momento do registo; lança `WebhookUrlBlockedError` |
| `resolveAndValidate` | `(url, options?) => Promise<ValidatedTarget>` | A mesma verificação, devolvendo os endereços resolvidos e o que fixar |
| `isPrivateIp` | `(ip) => boolean` | O próprio predicado de gamas; tudo o que não seja um IP público literal é `true` |
| `matchesEvent` | `(patterns, event) => boolean` | O comparador de padrões, para o `forEvent` de um store próprio |
| `webhookOutboxDispatch` | `(webhooks) => OutboxDispatch` | Adapta um `WebhookManager` a um dispatch de outbox; lança se algum endpoint falhar |

## Modos de falha e resolução de problemas

A maioria dos problemas de entrega **não são exceções** — voltam no
`DeliveryResult`, porque um endpoint mau não pode fazer falhar os outros:

| Resultado | `error` | `attempts` | Quando |
| --- | --- | --- | --- |
| Recusa SSRF | `Refusing to deliver webhook to <url>: <reason>` | `0` | Esquema inválido, ou o host é/resolve para um endereço privado, loopback, link-local, CGNAT, ULA ou reservado |
| Erro de cliente | `HTTP 4xx` | `1` | O recetor rejeitou — nunca repetido |
| Redirecionamento | `redirect refused` | `1` | O endpoint respondeu `3xx`; segui-lo derrotaria a verificação SSRF |
| Transitório | última mensagem de rede/timeout | `maxRetries + 1` | `5xx`, erro de ligação ou timeout por tentativa, repetido com backoff, e ainda a falhar |

| Erro | Código | HTTP | Quando |
| --- | --- | --- | --- |
| `WebhookUrlBlockedError` | — (só `name`) | — | Lançado por `assertDeliverableUrl` / `resolveAndValidate`; dentro de `deliver()` é apanhado e transformado no resultado falhado acima |
| `UnknownTokenError` | `DI_UNKNOWN_TOKEN` | — | `container.get(WEBHOOKS)` sem o `webhooksPlugin` registado |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | arranque | As tuas rotas de gestão de endpoints declaram `meta.auth` / `meta.teamRole` sem o plugin que as impõe |

- **Todas as entregas falham com `attempts: 0` em desenvolvimento** — a guarda
  SSRF está a recusar `localhost` / `127.0.0.1` / um nome `.local`. Usa um túnel
  com hostname público, ou `ssrf: { allowPrivateHosts: true }` só na configuração
  de dev.
- **Os recetores dizem que a assinatura está errada apesar de o secret bater
  certo** — estão a verificar sobre um corpo reserializado. O HMAC cobre os bytes
  exatos; captura o corpo raw antes do parse.
- **Os endpoints desaparecem a cada deploy** — continuas no
  `MemoryWebhookStore`. Passa para `webhooks-sqlite` ou `webhooks-prisma`.
- **Eventos emitidos de um job só chegam a alguns endpoints** — não há tenant em
  `ctx()` fora de um pedido, por isso só os endpoints globais (sem tenant)
  correspondem. Chama `dispatch(event, data, tenantId)` explicitamente.
- **Um handler de pedido ficou lento depois de adicionar webhooks** — o
  `dispatch` espera por todas as entregas, retries incluídos (até
  `(maxRetries + 1) × timeoutMs` por endpoint). Move-o para o outbox ou para um
  job de fila.
- **O outbox deixa de entregar um evento e nada aparece onde procuras** —
  atingiu `maxAttempts` e está morto; o `onDead` predefinido escreve em
  `console.error`. Inspeciona o `lastError` na entrada, ou liga o `outboxPlugin`
  com o teu próprio `onDead`.

## Ver também

- [Filas e jobs](/pt/guide/queues) — conduz a entrega a partir de uma fila para retries duráveis.
- [Persistência](/pt/guide/persistence) — stores duráveis, `prisma:sync`, o store do outbox.
- [Equipas](/pt/guide/teams) — quem pode gerir os endpoints de um tenant.
- [Cookbook de SaaS multi-tenant](/pt/cookbook/multi-tenant-saas) — endpoints por tenant numa app real.
