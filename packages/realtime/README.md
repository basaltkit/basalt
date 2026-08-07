# @machize/realtime

Comunicação em tempo real para o Machize: **push do servidor para o cliente** por WebSocket ou SSE, com **canais por tenant**, **presença** (quem está online) e uma **ponte de eventos** que liga os hooks de domínio da tua app diretamente aos clientes ligados. Precisas deste módulo quando queres atualizações ao vivo — notificações, feeds, dashboards, colaboração — sem o cliente andar a fazer *polling*.

## O que este módulo resolve

Numa aplicação normal o cliente pergunta ("há novidades?") repetidamente. Com realtime, é o **servidor que avisa** o cliente no instante em que algo acontece. Este módulo dá-te isso de forma:

- **Neutra de framework** — o núcleo (hub, canais, presença) não conhece sockets; os transportes (WebSocket/SSE) são finos e ligam-se ao teu adapter (Fastify/Express/Hono).
- **Multi-tenant** — os canais são isolados por tenant: `to('acme').channel('notes')` nunca entrega a clientes de outro tenant.
- **Multi-instância** — com o *backplane* de Redis, um `emit` numa instância chega aos clientes ligados a **qualquer** instância.
- **Testável sem servidor** — o núcleo testa-se com conexões falsas; não precisas de abrir sockets.

## Instalação

```bash
pnpm add @machize/realtime
```

Depende apenas de `@machize/core`. Para multi-instância precisas de um Redis (o cliente é injetado — normalmente `ioredis`).

## Começar em 5 minutos

### 1. Regista o plugin

```ts
import { createApp } from '@machize/core'
import { realtimePlugin, REALTIME } from '@machize/realtime'

const app = await createApp({
  plugins: [realtimePlugin()],
}).boot()
```

### 2. Liga um cliente (transporte)

O núcleo fala com **conexões** (`Connection`). Constróis uma a partir do socket/resposta do teu adapter e registas no hub. Exemplo com WebSocket:

```ts
import { REALTIME_HUB, websocketConnection } from '@machize/realtime'

// no handler de upgrade WebSocket do teu adapter, com o utilizador já autenticado:
const hub = app.container.get(REALTIME_HUB)
const conn = websocketConnection({ tenantId: tenant.id, userId: user.id }, socket)
hub.register(conn)
hub.subscribe(conn.id, 'notes') // subscreve os canais a que este cliente tem acesso

socket.on('close', () => hub.unregister(conn.id))
```

Com **SSE** é igual, mas fornecendo como escrever na resposta (neutro de framework):

```ts
import { sseConnection } from '@machize/realtime'

reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' })
const conn = sseConnection(
  { tenantId: tenant.id, userId: user.id },
  { write: (chunk) => reply.raw.write(chunk), end: () => reply.raw.end() },
)
hub.register(conn)
hub.subscribe(conn.id, 'notes')
reply.raw.on('close', () => hub.unregister(conn.id))
```

### 3. Emite do servidor

```ts
const realtime = app.container.get(REALTIME)
await realtime.to('acme').channel('notes').emit('created', { id: 1, title: 'Olá' })
// todos os clientes do tenant 'acme' subscritos a 'notes' recebem o evento
```

## Ponte de eventos (hooks → push)

Em vez de chamar `emit` à mão, liga um hook de domínio a um canal. Sempre que o hook dispara, o payload é empurrado para os clientes — sem tocar no código que emite o evento:

```ts
import { realtimePlugin, bridgeRule } from '@machize/realtime'

realtimePlugin({
  bridge: [
    bridgeRule({
      hook: 'note:created',            // um hook declarado na tua app
      tenant: (p) => p.tenantId,        // a que tenant entregar (undefined → ignora)
      channel: 'notes',                 // ou uma função (p) => `notes:${p.folderId}`
      event: 'created',
      data: (p) => p.note,              // opcional; por omissão envia o payload todo
    }),
  ],
})
```

O `bridgeRule` valida os tipos contra o payload do hook, por isso `p` tem o tipo certo.

## Presença

```ts
realtime.to('acme').channel('notes').presence() // → ['user-1', 'user-7']  (ids únicos online)
realtime.to('acme').channel('notes').count()    // → nº de conexões
```

A presença conta as conexões **desta instância**. Em multi-instância, cada nó conhece os seus clientes locais — para uma visão global agregada, some as instâncias (ou publique join/leave pelo backplane; enhancement futuro).

## Multi-instância com Redis

Passa um `RedisBackplane` para que um `emit` numa instância chegue aos clientes de todas. Fornece **dois** clientes Redis (um em modo subscribe não pode publicar):

```ts
import Redis from 'ioredis'
import { realtimePlugin, RedisBackplane } from '@machize/realtime'

realtimePlugin({
  backplane: new RedisBackplane({ publisher: new Redis(url), subscriber: new Redis(url) }),
})
```

O `emit` faz `PUBLISH`; o Redis entrega a **todas** as instâncias subscritas (incluindo a de origem), e cada hub entrega às suas conexões locais — o mesmo caminho serve um nó ou muitos.

## Referência da API

### `realtimePlugin(options?)`

| Opção | Tipo | Default | Descrição |
|---|---|---|---|
| `backplane` | `RealtimeBackplane` | `MemoryBackplane` | Fan-out entre instâncias. |
| `bridge` | `BridgeRule[]` | `[]` | Regras hook → canal (usa `bridgeRule(...)`). |

Regista os tokens `REALTIME` (`Realtime`) e `REALTIME_HUB` (`RealtimeHub`).

### `class Realtime`

| Método | Descrição |
|---|---|
| `to(tenantId).channel(name).emit(event, data?)` | Publica um evento no canal do tenant. |
| `to(tenantId).channel(name).presence()` | Ids de utilizador online (local). |
| `to(tenantId).channel(name).count()` | Nº de conexões (local). |

### `class RealtimeHub`

`register(conn)` · `unregister(connId)` · `subscribe(connId, channel)` · `unsubscribe(connId, channel)` · `publish(tenantId, channel, event, data)` · `presence(tenantId, channel)` · `count(tenantId, channel)` · `start()` · `close()`.

### Transportes

- `websocketConnection(meta, socket)` — de qualquer socket `ws`-like (`send`/`close`).
- `sseConnection(meta, { write, end })` — SSE; tu forneces como escrever/terminar.
- `sseFrame(message)` — formata uma mensagem como frame SSE.

### Backplanes

- `MemoryBackplane` — processo único (default).
- `RedisBackplane({ publisher, subscriber, channel? })` — Redis pub/sub (`channel` default `'machize:realtime'`).

## Como se liga aos outros módulos

- **`@machize/core`** — fornece `createApp`, tokens, e o barramento de hooks que a ponte de eventos consome.
- **`@machize/events`** — emite eventos de domínio; a `bridge` transforma-os em push.
- **`@machize/notifications`** — padrão comum: notificação persistida **e** empurrada ao vivo pelo mesmo evento.
- **`@machize/tenancy` / `@machize/auth`** — de onde vêm o `tenantId`/`userId` que atribuis a cada conexão.
