# Realtime

`@basaltkit/realtime` empurra eventos do servidor para os clientes ligados através
de WebSocket ou SSE, com **canais por tenant** e **presença**. A sua metade no
browser, [`@basaltkit/realtime-client`](#browser-client), subscreve e religa-se.
Juntos transformam um evento de domínio numa atualização de UI ao vivo, de ponta a ponta.

[[toc]]

## Setup

```ts
import { createApp } from '@basaltkit/core'
import { realtimePlugin, REALTIME } from '@basaltkit/realtime'

const app = await createApp({
  plugins: [realtimePlugin()],
}).boot()

const realtime = app.container.get(REALTIME)
await realtime.to('acme').channel('notes').emit('created', { id: 1, title: 'Hi' })
```

`to(tenantId).channel(name).emit(event, data)` entrega a cada cliente desse tenant
subscrito nesse canal — e a mais ninguém. Os canais são sempre delimitados por
tenant.

## Ligar um cliente (transporte)

O core comunica com **connections**, não com sockets. Constrói uma `Connection` a
partir do socket/response do teu adaptador e regista-a — a parte específica da
framework são apenas essas duas linhas.

```ts
import { REALTIME_HUB, websocketConnection } from '@basaltkit/realtime'

// in your WebSocket upgrade handler, once the user is authenticated:
const hub = app.container.get(REALTIME_HUB)
const conn = websocketConnection({ tenantId: tenant.id, userId: user.id }, socket)
hub.register(conn)
hub.subscribe(conn.id, 'notes') // authorize + subscribe the channels this user may see

socket.on('message', (raw) => {
  const cmd = JSON.parse(raw) // { type: 'subscribe' | 'unsubscribe', channel }
  if (cmd.type === 'subscribe') hub.subscribe(conn.id, cmd.channel)
  if (cmd.type === 'unsubscribe') hub.unsubscribe(conn.id, cmd.channel)
})
socket.on('close', () => hub.unregister(conn.id))
```

::: warning Aviso
Nunca confies cegamente na escolha de canal do cliente — verifica que o utilizador
autenticado pode aceder a um canal antes de chamar `hub.subscribe`.
:::

**SSE** é igual, mas fornece a forma de escrever na resposta:

```ts
import { sseConnection } from '@basaltkit/realtime'

reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
const conn = sseConnection(
  { tenantId: tenant.id, userId: user.id },
  { write: (chunk) => reply.raw.write(chunk), end: () => reply.raw.end() },
)
hub.register(conn)
hub.subscribe(conn.id, 'notes')
reply.raw.on('close', () => hub.unregister(conn.id))
```

## SSE simples a partir de uma rota

Para streaming unidirecional simples — progresso, logs, um contador ao vivo — não
precisas dos canais acima. Devolve `sse()` de qualquer rota e faz streaming de
`text/event-stream` em **todos os adaptadores** (Fastify, Express, Hono):

```ts
import { sse, route } from '@basaltkit/http'

route({
  method: 'GET',
  url: '/progress/:job',
  async handler({ params }) {
    return sse(async (stream) => {
      stream.onClose(() => stopWatching(params.job)) // cliente desligou-se
      for await (const pct of watch(params.job)) {
        stream.send({ event: 'progress', data: { pct } })
        if (pct === 100) break
      }
      stream.close()
    })
  },
})
```

O `stream.send(event)` codifica um objeto em JSON (ou envia uma string como
`data:`); `event`, `id` e `retry` são opcionais. No browser:

```js
const es = new EventSource('/progress/42')
es.addEventListener('progress', (e) => console.log(JSON.parse(e.data).pct))
```

Usa o pacote realtime baseado em canais (acima) só quando precisas de pub/sub,
fan-out por tenant ou presença.

## Servidor WebSocket Fastify completo

Juntando tudo com `@fastify/websocket` — `realtimePlugin` regista tanto
`REALTIME` como `REALTIME_HUB` e arranca o hub no boot:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { realtimePlugin, REALTIME_HUB, websocketConnection } from '@basaltkit/realtime'
import fastifyWebsocket from '@fastify/websocket'

const app = await createApp({ plugins: [fastifyPlugin(), realtimePlugin()] }).boot()

const fastify = app.container.get(FASTIFY)
const hub = app.container.get(REALTIME_HUB)
await fastify.register(fastifyWebsocket)

fastify.get('/realtime', { websocket: true }, (socket, request) => {
  // authenticate the connection (JWT in query, cookie, header…) → tenant + user
  const { tenantId, userId } = authenticate(request)
  const conn = websocketConnection({ tenantId, userId }, socket)
  hub.register(conn)

  socket.on('message', (raw) => {
    const cmd = JSON.parse(raw.toString()) // { type: 'subscribe' | 'unsubscribe', channel }
    if (cmd.type === 'subscribe' && mayAccess(userId, cmd.channel)) hub.subscribe(conn.id, cmd.channel)
    if (cmd.type === 'unsubscribe') hub.unsubscribe(conn.id, cmd.channel)
  })
  socket.on('close', () => hub.unregister(conn.id))
})

await fastify.listen({ port: 3000 })
```

## Ponte de eventos

Liga um hook de domínio diretamente a um canal — os pushes acontecem sem tocar no
código emissor:

```ts
import { realtimePlugin, bridgeRule } from '@basaltkit/realtime'

realtimePlugin({
  bridge: [
    bridgeRule({
      hook: 'note:created',
      tenant: (p) => p.tenantId,
      channel: 'notes',        // or (p) => `notes:${p.folderId}`
      event: 'created',
      data: (p) => p.note,     // default: the whole payload
    }),
  ],
})
```

## Presença

```ts
realtime.to('acme').channel('notes').presence() // → user ids online
realtime.to('acme').channel('notes').count()    // → connection count
```

A presença reflete as connections desta instância. Entre instâncias, cada nó
conhece os seus clientes locais — soma-os para uma visão global.

## Escalar horizontalmente (backplane Redis)

Por defeito o backplane é em memória (um processo). Para várias instâncias, passa
um `RedisBackplane` para que um emit num nó chegue aos clientes de todos os nós:

```ts
import Redis from 'ioredis'
import { realtimePlugin, RedisBackplane } from '@basaltkit/realtime'

realtimePlugin({
  backplane: new RedisBackplane({ publisher: new Redis(url), subscriber: new Redis(url) }),
})
```

Um emit faz `PUBLISH` no Redis; cada instância recebe-o via `SUBSCRIBE` (incluindo
a origem) e entrega às suas connections locais — um único caminho de código para
um ou muitos nós. Fornece **dois** clientes: uma connection subscritora não pode
publicar.

## Cliente de browser

`@basaltkit/realtime-client` é um cliente sem dependências que usa o `WebSocket`/
`EventSource` nativo do browser.

```bash
npm add @basaltkit/realtime-client
```

```ts
import { createRealtimeClient } from '@basaltkit/realtime-client'

const client = createRealtimeClient({ url: 'wss://api.example.com/realtime' })

client.channel('notes').on('created', (note) => addToUi(note))
client.channel('notes').on('deleted', ({ id }) => removeFromUi(id))
client.on('close', () => showReconnectingBadge())

client.connect()
```

Registar um handler subscreve o canal automaticamente; o cliente volta a subscrever
todos os canais ativos quando a connection (re)abre, e religa-se com backoff
exponencial até chamares `client.close()`. Passa `transport: 'sse'` para
Server-Sent Events, ou `reconnect: false` para desativar a religação automática.

## De ponta a ponta

```
note created ─▶ note:created hook ─▶ bridge ─▶ realtime.emit
             ─▶ Redis backplane ─▶ every instance
             ─▶ each hub delivers to local WS/SSE connections
             ─▶ browser client 'created' handler ─▶ UI updates
```

Vê o [cookbook do SaaS de notas](/pt/cookbook/notes-saas) para a app envolvente.
