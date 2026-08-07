# @machize/realtime-client

Cliente de **browser** para o [`@machize/realtime`](https://www.npmjs.com/package/@machize/realtime): subscreve canais, recebe eventos em tempo real por **WebSocket** ou **SSE**, e reconecta sozinho. **Zero dependências** — usa o `WebSocket`/`EventSource` nativos do browser.

## O que este módulo resolve

Do lado do servidor, o `@machize/realtime` empurra eventos para canais por tenant. Este pacote é a outra metade: o que corre no **navegador** (ou em qualquer runtime com `WebSocket`) para ouvir esses eventos e atualizar a UI ao vivo — com reconexão automática e re-subscrição transparente.

## Instalação

```bash
pnpm add @machize/realtime-client
```

Sem dependências. Em ambientes sem `WebSocket`/`EventSource` global (Node antigo, testes) injeta a implementação.

## Começar em 5 minutos

```ts
import { createRealtimeClient } from '@machize/realtime-client'

const client = createRealtimeClient({ url: 'wss://api.exemplo.com/realtime' })

client.channel('notes').on('created', (note) => {
  // atualizar a UI com a nota nova
})
client.channel('notes').on('deleted', ({ id }) => {
  // remover da UI
})

client.on('open', () => console.log('ligado'))
client.on('close', () => console.log('desligado (a reconectar…)'))

client.connect()
```

Registar um handler com `channel(name).on(event, ...)` **subscreve automaticamente** o canal. Quando a ligação abre (ou reabre), o cliente re-subscreve todos os canais ativos.

## API

### `createRealtimeClient(options)`

| Opção | Tipo | Default | Descrição |
|---|---|---|---|
| `url` | `string` | — | Endpoint do servidor (`wss://…` ou `https://…/sse`). |
| `transport` | `'websocket' \| 'sse'` | `'websocket'` | Mecanismo de ligação. |
| `WebSocketImpl` / `EventSourceImpl` | ctor | globais | Implementação injetável (testes / não-browser). |
| `reconnect` | `false \| { minDelayMs?, maxDelayMs? }` | `{}` | Reconexão com backoff exponencial. `false` desliga. |

Devolve um `RealtimeClient`:

| Membro | Descrição |
|---|---|
| `connect()` | Abre a ligação. |
| `close()` | Fecha (e desliga a reconexão). |
| `channel(name)` | Devolve um `Channel`. |
| `on('open' \| 'close' \| 'error', handler)` | Eventos de ciclo de vida. Devolve uma função para remover. |
| `connected` | `boolean` — estado atual. |

### `Channel`

| Método | Descrição |
|---|---|
| `on(event, handler)` | Ouve um evento (subscreve o canal). Devolve uma função para remover. |
| `off(event, handler?)` | Remove um handler (ou todos os do evento). |
| `subscribe()` / `unsubscribe()` | Controla a subscrição do canal manualmente. |

## WebSocket vs SSE

- **WebSocket** (recomendado) — bidirecional; o cliente envia comandos `{ type: 'subscribe' \| 'unsubscribe', channel }` e recebe mensagens `{ channel, event, data }`.
- **SSE** — só recebe. As subscrições são decididas pelo servidor (pela URL/utilizador autenticado). O cliente ouve por nome de evento e encaminha por canal.

### Lado do servidor (WebSocket)

O `@machize/realtime` decide as subscrições via `hub.subscribe(...)`. Interpreta os comandos do cliente no teu handler WebSocket:

```ts
socket.on('message', (raw) => {
  const cmd = JSON.parse(raw)
  if (cmd.type === 'subscribe') hub.subscribe(conn.id, cmd.channel)
  if (cmd.type === 'unsubscribe') hub.unsubscribe(conn.id, cmd.channel)
})
```

(Autoriza sempre no servidor a que canais um cliente pode subscrever — nunca confies no cliente.)

## Como se liga aos outros módulos

- **`@machize/realtime`** — o servidor que empurra os eventos que este cliente recebe. O formato das mensagens é partilhado (`{ channel, event, data }`).
