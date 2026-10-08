# Realtime

`@basaltkit/realtime` empurra eventos do servidor para os clientes ligados através
de WebSocket ou SSE, com **canais por tenant** e **presença**. Está desacoplado da
tua framework HTTP — o core só vê um objeto `Connection`, por isso a mesma
montagem corre em Fastify, Express e Hono — e do teu código de domínio, que nunca
tem de saber que alguém está à escuta. A sua metade no browser,
[`@basaltkit/realtime-client`](#cliente-de-browser), subscreve e religa-se.
Usa-o quando uma alteração feita por um utilizador tem de aparecer no ecrã de
outro sem polling.

[[toc]]

## Modelo mental

Seis peças, e apenas duas são específicas da framework:

| Peça | O que é | Onde vive |
| --- | --- | --- |
| `Realtime` (token `REALTIME`) | A fachada fluente que chamas: `to(tenant).channel(name).emit()` | o teu código |
| `RealtimeHub` (token `REALTIME_HUB`) | Registo de connections, subscrições e presença; entrega aos sockets locais | um por processo |
| `Connection` | `{ id, tenantId, userId?, send(), close() }` — construída a partir do teu socket/stream por `websocketConnection()` / `realtimeSse()` (`sseStreamConnection()`) / `sseConnection()` | por cliente |
| `RealtimeBackplane` | Fan-out entre processos: `MemoryBackplane` (predefinição) ou `RedisBackplane` | processo / Redis |
| Regras de ponte | Mapeiam um hook do core para um emit, fire-and-forget | em `app.hooks` |
| `@basaltkit/realtime-client` | Cliente de browser: subscrição e religação automáticas | browser |

O caminho é sempre o mesmo: o `emit` **publica no backplane**, o backplane entrega
a cada hub (**incluindo aquele que publicou**), e cada hub escreve nas suas
connections locais. É um único caminho de código, quer corras um nó quer vinte —
o backplane Redis é uma troca, não um modo diferente.

Duas consequências a interiorizar já: **a presença e as contagens de connections
são por nó** (um hub só conhece os seus próprios sockets), e **a entrega é
fire-and-forget** — nada no caminho realtime pode falhar uma escrita de domínio.

## Arranque rápido

O `realtimePlugin` regista tanto `REALTIME` como `REALTIME_HUB` e arranca o hub no
boot. Isto é um servidor WebSocket Fastify completo e executável:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { realtimePlugin, REALTIME, REALTIME_HUB, websocketConnection } from '@basaltkit/realtime'
import fastifyWebsocket from '@fastify/websocket'

const app = await createApp({
  plugins: [
    fastifyPlugin(),
    realtimePlugin({
      // recusa canais a que esta connection não pode aderir — ver "Autorizar subscrições"
      authorize: (connection, channel) => channel === 'notes' || channel === `user:${connection.userId}`,
    }),
  ],
}).boot()

const fastify = app.container.get(FASTIFY)
const hub = app.container.get(REALTIME_HUB)
await fastify.register(fastifyWebsocket)

const ALLOWED_ORIGINS = new Set(['https://app.example.com'])

fastify.get('/realtime', { websocket: true }, (socket, request) => {
  // recusa páginas alheias primeiro — vê "Sequestro de WebSocket entre sites" abaixo
  if (!ALLOWED_ORIGINS.has(String(request.headers.origin))) return socket.close()
  // autentica a connection (JWT na query, cookie, header…) → tenant + utilizador
  const { tenantId, userId } = authenticate(request)
  const conn = websocketConnection({ tenantId, userId }, socket)
  hub.register(conn)

  socket.on('message', async (raw) => {
    // cada frame é controlada pelo cliente; um throw aqui é uma rejeição não tratada (fatal no Node)
    let cmd: { type?: unknown; channel?: unknown }
    try {
      cmd = JSON.parse(raw.toString())
    } catch {
      return socket.close()
    }
    if (typeof cmd?.channel !== 'string') return socket.close()
    if (cmd.type === 'subscribe') {
      const ok = await hub.subscribe(conn.id, cmd.channel) // false = recusado
      if (!ok) socket.send(JSON.stringify({ error: 'subscribe_refused', channel: cmd.channel }))
    } else if (cmd.type === 'unsubscribe') {
      hub.unsubscribe(conn.id, cmd.channel)
    }
  })
  socket.on('close', () => hub.unregister(conn.id))
})

await fastify.listen({ port: 3000 })

// em qualquer ponto da tua app:
const realtime = app.container.get(REALTIME)
await realtime.to('acme').channel('notes').emit('created', { id: 1, title: 'Hi' })
```

`to(tenantId).channel(name).emit(event, data)` entrega a cada cliente desse tenant
subscrito nesse canal — e a mais ninguém. Os canais são sempre delimitados por
tenant: `('acme', 'notes')` e `('globex', 'notes')` são canais diferentes que
nunca conseguem ver o tráfego um do outro.

## Ligar um cliente (transporte)

O core comunica com **connections**, não com sockets. Constrói uma `Connection` a
partir do teu transporte e regista-a — essa é toda a superfície específica da
framework.

Para **SSE**, devolve o `sse()` do `@basaltkit/http` com `realtimeSse(hub, …)` como
produtor. Corre sem alterações em Fastify, Express e Hono: regista a connection,
junta-a aos canais (cada um passa pelo `authorize`) e remove-a quando o cliente
sai.

```ts
import { ctx } from '@basaltkit/core'
import { route, sse } from '@basaltkit/http'
import { realtimeSse, REALTIME_HUB } from '@basaltkit/realtime'

const hub = app.container.get(REALTIME_HUB)

route({
  method: 'GET',
  url: '/live',
  meta: { auth: true },
  handler: () => {
    const { tenant, user } = ctx() as { tenant: { id: string }; user: { id: string } }
    return sse(
      realtimeSse(hub, {
        meta: { tenantId: tenant.id, userId: user.id }, // da sessão, nunca do cliente
        channels: ['notes', `user:${user.id}`],
        onOpen: () => { /* opcional: enviar um snapshot */ },
      }),
      { heartbeatMs: 15_000 },
    )
  },
})
```

Um canal que o hub recusa fecha o stream — o `EventSource` voltaria a ligar e
seria recusado de novo, por isso verifica o acesso no handler primeiro quando o
cliente deve receber um `403`. A backpressure nunca remove um cliente lento: um
envio que encontra o buffer cheio é contado, e o stream é fechado ao fim de
`maxBackpressure` (por omissão 50) seguidos.

Para **WebSockets**, `websocketConnection(meta, socket)` aceita qualquer socket ao
estilo `ws` (`send(string)` + `close()`). O `sseConnection(meta, io)` de baixo
nível continua disponível como saída de emergência para uma resposta que escreves
tu (`{ write(chunk), end() }`, já enquadrada com `sseFrame`) — aí registar,
subscrever e remover no fecho ficam a teu cargo.

`ConnectionMeta` é `{ tenantId, userId?, id? }` — o `id` tem como predefinição um
`randomUUID()`. **O `userId` é o que alimenta a presença**: uma connection
registada sem ele recebe entregas normalmente mas nunca aparece em `presence()`.

Na rede, uma connection WebSocket recebe `JSON.stringify({ channel, event, data })`;
uma connection SSE recebe uma frame `event: <event>` cujo `data:` é
`{ channel, data }` (CR, LF e NUL são removidos do nome do evento, para que um
nome de evento nunca consiga injectar campos ou frames SSE extra). O `@basaltkit/realtime-client` normaliza ambos de volta para a
mesma assinatura de handler.

::: warning O `unregister` é da tua responsabilidade
O hub só remove uma connection automaticamente quando o seu `send` **lança** — e
nesse caso chama também o seu `close()`, para que o cliente veja a queda e volte
a ligar. Um
socket que fecha limpamente continua registado até chamares
`hub.unregister(conn.id)` — liga-o sempre ao evento de fecho do teu transporte,
ou as subscrições e a presença ficam a vazar durante toda a vida do processo.
(O `realtimeSse()` faz isto por ti.)
:::

## Autorizar subscrições

`hub.subscribe(connectionId, channel)` é `async` e devolve um **booleano**:
`false` significa que a subscrição foi recusada. É recusada quando o id da
connection é desconhecido — ou foi removido ou substituído enquanto o `authorize`
ainda decidia — quando o canal não é uma string, quando está vazio ou é mais longo que
`maxChannelLength` (predefinição 256), quando a connection já detém
`maxSubscriptionsPerConnection` canais (predefinição 1000), ou quando o portão
`authorize` devolveu `false`. Voltar a subscrever um canal que já detém é
idempotente e devolve `true`.

```ts
realtimePlugin({
  authorize: async (connection, channel) => {
    if (channel === 'notes') return true                        // todo o tenant
    if (channel === `user:${connection.userId}`) return true     // canal privado próprio
    if (channel === 'admin') return isAdmin(connection.userId)   // async não faz mal
    return false
  },
  maxSubscriptionsPerConnection: 200,
  maxChannelLength: 128,
})
```

::: danger Não há portão por predefinição
Sem `authorize`, **qualquer connection autenticada pode subscrever qualquer nome
de canal dentro do seu tenant** — incluindo o canal privado de outro utilizador,
se lhe deste o nome do id dele. A fronteira do tenant é imposta automaticamente; tudo o que
for mais fino do que isso é o `authorize`. Define-o sempre que um canal transporta
algo que não é legível por todos os membros do tenant, e verifica o booleano que o
`subscribe` devolve em vez de assumires sucesso.
:::

Os dois tetos são limites anti-DoS, não regras de negócio: impedem que um socket
aloque entradas de subscrição sem limite com nomes de canal gerados. O teto e a
connection voltam a ser verificados depois de o `authorize` resolver, por isso
uma rajada de comandos `subscribe` concorrentes não ultrapassa o teto, e um
socket que fechou a meio do portão nunca deixa uma subscrição fantasma. Vê
[Segurança](/pt/guide/security) para os equivalentes na borda do pedido.

::: danger Sequestro de WebSocket entre sites
Os browsers anexam cookies ao handshake de um WebSocket vindo de **qualquer**
site, e a política de mesma origem não se aplica a WebSockets. Se o teu socket
autentica por cookie, uma página maliciosa pode abri-lo como o utilizador com
sessão iniciada e ler todos os eventos enviados para ele — o `authorize` não
distingue, porque *é* esse utilizador. Verifica o header `Origin` contra uma
lista de permitidos antes de aceitar o upgrade (como faz o arranque rápido), ou
autentica com um token que a página tenha de enviar explicitamente em vez de um
cookie ambiente.
:::

## SSE simples a partir de uma rota

Para streaming unidirecional simples — progresso, logs, um contador ao vivo — não
precisas de canais, presença nem backplane. Devolve `sse()` de qualquer rota e faz
streaming de `text/event-stream` em **todos os adaptadores** (Fastify, Express, Hono):

```ts
import { sse, route } from '@basaltkit/http'

route({
  method: 'GET',
  url: '/progress/:job',
  async handler({ params }) {
    return sse(
      async (stream) => {
        stream.onClose(() => stopWatching(params.job)) // cliente desligou-se
        for await (const pct of watch(params.job)) {
          if (!stream.send({ event: 'progress', data: { pct } })) break // backpressure
          if (pct === 100) break
        }
        stream.close()
      },
      { heartbeatMs: 15_000, maxDurationMs: 300_000 },
    )
  },
})
```

O `stream.send(event)` codifica um objeto em JSON (ou envia uma string como
`data:` simples) e devolve **`false`** quando o stream está fechado ou o buffer de
escrita do transporte está cheio — respeita-o, ou um cliente lento faz crescer a
tua heap. `event`, `id` e `retry` são campos opcionais; CR/LF são removidos de
`event` e `id` para que um valor não consiga injetar frames SSE extra. No browser:

```js
const es = new EventSource('/progress/42')
es.addEventListener('progress', (e) => console.log(JSON.parse(e.data).pct))
```

Usa o pacote baseado em canais (acima) só quando precisas de pub/sub, fan-out por
tenant ou presença.

## Ponte de eventos

Uma regra de ponte liga um **hook do core** (`app.hooks`, o mesmo bus onde a
tenancy, o auth e as teams emitem) diretamente a um canal, para que os pushes
aconteçam sem tocar no código emissor:

```ts
import { realtimePlugin, bridgeRule } from '@basaltkit/realtime'

// o teu hook, declarado uma vez para a regra ser verificada contra o seu payload
declare module '@basaltkit/core' {
  interface BasaltHooks {
    'note:created': { tenantId: string; note: { id: string; title: string } }
  }
}

realtimePlugin({
  bridge: [
    bridgeRule({
      hook: 'note:created',
      tenant: (p) => p.tenantId,   // devolve undefined para ignorar este evento
      channel: 'notes',            // ou (p) => `notes:${p.folderId}`
      event: 'created',
      data: (p) => p.note,         // predefinição: o payload inteiro
    }),
  ],
  onBridgeError: (error, { hook, channel, event }) =>
    logger.error({ err: error, hook, channel, event }, 'realtime bridge failed'),
})
```

O `bridgeRule()` verifica os tipos de uma regra contra o payload desse hook e
depois apaga o genérico, para que regras de hooks diferentes vivam no mesmo array.
As regras são ligadas durante o `boot`.

### Tenant a partir do contexto (apps com schema ou base de dados por tenant)

Quando a tenancy isola por schema Postgres ou por base de dados, os modelos de
domínio não têm coluna `tenantId`, por isso o payload não tem nada para onde o
`tenant` possa apontar. **Omite o `tenant`** e a ponte vai buscar o tenant ao
contexto ativo quando o hook dispara: `ctx().tenant.id`, definido pelo
`@basaltkit/tenancy`. Os handlers de hooks correm dentro do contexto assíncrono
de quem emite, por isso um hook emitido durante um pedido ou job com tenant é
entregue a esse tenant.

```ts
declare module '@basaltkit/core' {
  interface BasaltHooks {
    'matter:opened': { matter: { id: string; title: string } } // sem tenantId
  }
}

realtimePlugin({
  bridge: [
    bridgeRule({
      hook: 'matter:opened',
      // sem `tenant`: entregue a ctx().tenant.id no momento do emit
      channel: 'matters',
      event: 'opened',
      data: (p) => p.matter,
    }),
  ],
  onBridgeSkipped: ({ hook, channel, event, reason }) =>
    logger.warn({ hook, channel, event, reason }, 'realtime bridge skipped'),
})
```

As duas formas de um evento ser ignorado comportam-se de propósito de maneira
diferente:

| Regra | O tenant resolve para | O que acontece |
| --- | --- | --- |
| `tenant` definido | uma string | Entregue a esse tenant; o contexto é ignorado |
| `tenant` definido | `undefined` | Ignorado **em silêncio**: é uma exclusão explícita, por isso é a forma de filtrar eventos |
| `tenant` omitido | tenant no contexto | Entregue a `ctx().tenant.id` |
| `tenant` omitido | sem tenant no contexto | Ignorado e reportado a **`onBridgeSkipped({ hook, channel, event, reason: 'no-tenant' })`** |

Sem tenant no contexto, o hook foi emitido fora de um âmbito com tenant: o
`boot`, um tick de cron, ou um worker que não restaurou o contexto. Deixa o
`onBridgeSkipped` por definir e a predefinição regista
`[basalt:realtime] bridge skipped (hook "…" -> channel "…", event "…")` via
`console.warn`, **uma vez por regra** e não uma vez por evento, para uma regra mal
configurada se notar sem inundar os logs. Com um `channel` função, o canal
reportado é avaliado contra o payload; se isso lançar, recebes o marcador
`'<dynamic>'`.

::: warning Não leias um id de tenant que o payload não traz
`tenant: ({ matter }) => matter?.tenantId` num modelo sem coluna `tenantId`
devolve sempre `undefined`, e essa é a exclusão *silenciosa*: nada é enviado e
nada é registado. Omite o `tenant`.
:::

::: tip A ponte nunca pode falhar a tua escrita de domínio
O emit é deliberadamente **fire-and-forget**: o handler do hook não o aguarda, por
isso um backplane morto não consegue rejeitar para dentro da — nem atrasar a —
transação que emitiu o hook. Um push realtime é cosmético; a escrita não é. A
rejeição é entregue a **`onBridgeError(error, { hook, channel, event })`**. Deixa-o
por definir e a predefinição regista
`[basalt:realtime] bridge broadcast failed (hook "…" -> channel "…", event "…")`
via `console.error` — nunca silencioso, mas também nunca encaminhado para o teu
logger. Define-o em produção para a falha aterrar no mesmo sítio que tudo o resto
sobre o qual alertas.
:::

## Presença

```ts
realtime.to('acme').channel('notes').presence() // → ids de utilizador online (este nó)
realtime.to('acme').channel('notes').count()    // → contagem de connections (este nó)
```

Ambos são **síncronos e locais**. O `presence()` devolve os `userId` distintos das
connections subscritas nesse canal *neste processo*; connections registadas sem
`userId` são-lhe invisíveis, e o `count()` conta connections, não utilizadores —
um utilizador com três separadores dá `count() === 3` e uma entrada em
`presence()`.

Entre instâncias, cada nó conhece apenas os seus clientes. Para uma visão global,
soma-os: expõe um pequeno endpoint interno por nó e agrega, ou faz cada nó publicar
a sua presença local num temporizador. O backplane não replica estado de presença.

## Escalar horizontalmente (backplane Redis)

Por predefinição o backplane é o `MemoryBackplane` — a publicação volta
diretamente para o mesmo processo. Para várias instâncias, passa um
`RedisBackplane` para que um emit num nó chegue aos clientes de todos os nós:

```ts
import Redis from 'ioredis'
import { realtimePlugin, RedisBackplane } from '@basaltkit/realtime'

const publisher = new Redis(process.env.REDIS_URL!)
const subscriber = new Redis(process.env.REDIS_URL!)

realtimePlugin({
  backplane: new RedisBackplane({ publisher, subscriber, channel: 'basalt:realtime' }),
})
```

Um emit faz `PUBLISH` num canal Redis; cada instância recebe-o via `SUBSCRIBE`
(**incluindo a origem**) e entrega às suas connections locais. Fornece **dois**
clientes: uma connection em modo de subscrição não pode publicar.

O canal Redis é partilhado por **tudo o que, nesse Redis, use o mesmo nome**, e
uma mensagem identifica o seu tenant apenas pelo id. Duas apps — ou staging e
produção — que mantenham ambas o `'basalt:realtime'` predefinido entregam nos
tenants uma da outra, e qualquer um capaz de fazer `PUBLISH` nesse Redis pode
enviar um evento para qualquer tenant. Dá a cada deployment o seu próprio
`channel`, e define `secret` para assinar as mensagens com HMAC-SHA256:

```ts
new RedisBackplane({
  publisher,
  subscriber,
  channel: 'myapp:prod:realtime',
  secret: process.env.REALTIME_BACKPLANE_SECRET!, // [novaChave, chaveAntiga] durante a rotação
})
```

Com `secret`, mensagens não assinadas, adulteradas ou com outra chave são
descartadas e registadas. A primeira chave assina e todas verificam, por isso a
rotação é: publica `[nova, antiga]` em todo o lado, depois só `nova`. Todas as
instâncias têm de concordar — um nó com secret e outro sem descartam os envios
um do outro.

Estão embutidas duas propriedades de robustez, porque uma exceção que escape ao
emissor `'message'` do ioredis é um `uncaughtException` e mataria o processo:
payloads não analisáveis e payloads sem `tenantId`/`channel`/`event` são
**descartados e registados** em vez de lançados, e um único socket morto durante a
entrega local é removido (e fechado) enquanto os restantes destinatários continuam
a receber a mensagem. Um payload que o JSON não consegue codificar (um `BigInt`,
um ciclo) nem chega lá: o `emit()` rejeita com o `TypeError` em qualquer
backplane, antes de enviar o que quer que seja.

::: warning Fecha tu os clientes Redis
O `app.shutdown()` fecha cada connection e chama o `close()` opcional do backplane.
O `RedisBackplane` não implementa nenhum, por isso os dois clientes ioredis ficam
abertos — termina-os no teu próprio caminho de encerramento ou o processo não sai.
:::

## Cliente de browser

`@basaltkit/realtime-client` é um cliente sem dependências sobre o `WebSocket`/
`EventSource` nativo do browser.

```bash
npm add @basaltkit/realtime-client
```

```ts
import { createRealtimeClient } from '@basaltkit/realtime-client'

const client = createRealtimeClient({
  url: 'wss://api.example.com/realtime',
  reconnect: { minDelayMs: 500, maxDelayMs: 10_000 },
})

const off = client.channel('notes').on('created', (note) => addToUi(note))
client.channel('notes').on('deleted', ({ id }) => removeFromUi(id))
client.on('close', () => showReconnectingBadge())
client.on('error', (err) => console.warn('realtime', err))

client.connect()
// mais tarde: off()  — remove um handler
// client.channel('notes').unsubscribe()  — sai do canal
// client.close() — para a religação definitivamente
```

Registar um handler subscreve o canal automaticamente. Em cada (re)abertura, o
cliente reenvia `subscribe` para **todos** os canais ativos, por isso uma
religação repõe o estado sem tu o acompanhares. O atraso de religação é
`min(maxDelayMs, minDelayMs · 2^tentativas)` com 50–100 % de jitter, reposto numa
abertura bem-sucedida; `reconnect: false` desativa-o, e `client.close()` para-o
permanentemente (um `connect()` posterior volta a ativá-lo).

::: warning O SSE é só de receção
Com `transport: 'sse'`, os comandos `subscribe`/`unsubscribe` **não são enviados** —
o `EventSource` não tem canal ascendente. O servidor tem de derivar os canais da
connection a partir do URL ou do utilizador autenticado no momento da ligação, e o
cliente só usa o seu registo de canais para encaminhar as frames recebidas. Usa o
transporte WebSocket predefinido sempre que os clientes precisem de escolher os
seus próprios canais.
:::

Em testes ou em Node, injeta as implementações de socket com `WebSocketImpl` /
`EventSourceImpl` — sem um global e sem override, o `createRealtimeClient` lança
imediatamente. Vê [Testes](/pt/guide/testing).

## De ponta a ponta

```
note created ─▶ note:created hook ─▶ bridge rule ─▶ realtime.emit
             ─▶ backplane (memory or Redis PUBLISH)
             ─▶ every instance's hub ─▶ local WS/SSE connections
             ─▶ browser client 'created' handler ─▶ UI updates
```

## Referência de opções

`realtimePlugin(options)`:

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `backplane` | `RealtimeBackplane` | `new MemoryBackplane()` | Fan-out entre processos; passa `RedisBackplane` para correr mais do que uma instância |
| `bridge` | `BridgeRule[]` | `[]` | Mapeia hooks do core para emits, para o código de domínio ignorar o realtime |
| `authorize` | `(connection, channel) => boolean \| Promise<boolean>` | permite tudo | Portão de subscrição no servidor — a única coisa entre uma connection e qualquer nome de canal do seu tenant |
| `maxSubscriptionsPerConnection` | `number` | `1000` | Limite anti-DoS: canais que uma connection pode deter |
| `maxChannelLength` | `number` | `256` | Limite anti-DoS: comprimento máximo do nome do canal |
| `onBridgeError` | `(error, { hook, channel, event }) => void` | `console.error` | Onde é reportado um broadcast **da ponte** que falhou; a falha nunca chega ao código de domínio emissor |
| `onBridgeSkipped` | `(info: { hook, channel, event, reason: 'no-tenant' }) => void` | `console.warn`, uma vez por regra | Onde uma regra **sem `tenant`** reporta um evento ignorado por não haver tenant no contexto. Não é chamado quando o teu `tenant` devolve `undefined` |
| `onDeliveryError` | `(error, { connectionId, tenantId, channel, event }) => void` | `console.error` | Onde é reportada uma **escrita local** falhada num socket; essa connection é removida, as restantes continuam a receber a mensagem |

`bridgeRule(rule)`:

| Campo | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `hook` | `keyof BasaltHooks & string` | — | O hook do core a escutar |
| `tenant` | `(payload) => string \| undefined` | tenant no contexto | A que tenant entregar; `undefined` ignora o evento em silêncio. Omite-o para usar `ctx().tenant.id` no momento do emit (apps com schema/base de dados por tenant); sem tenant aí, o evento é ignorado e reportado a `onBridgeSkipped` |
| `channel` | `string \| (payload) => string` | — | Nome de canal fixo ou derivado do payload |
| `event` | `string` | — | Nome do evento que o cliente escuta |
| `data` | `(payload) => unknown` | payload inteiro | Restringe o que sai do servidor — o payload é entregue a cada subscritor |

`new RedisBackplane(options)`:

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `publisher` | `RedisRealtimeClient` | — | Cliente usado para `PUBLISH` (não pode estar em modo de subscrição) |
| `subscriber` | `RedisRealtimeClient` | — | Cliente usado para `SUBSCRIBE` |
| `channel` | `string` | `'basalt:realtime'` | Canal Redis partilhado pelas instâncias; dá a cada app/ambiente num só Redis o seu próprio |
| `secret` | `string \| string[]` | sem assinatura | Chave(s) HMAC-SHA256: a primeira assina, todas verificam; mensagens sem assinatura ou mal assinadas são descartadas. Vazio lança na construção |

`sse(producer, options)` (de `@basaltkit/http`):

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `heartbeatMs` | `number` | desligado | Intervalo do ping de comentário — impede proxies de fechar um stream inativo e expõe sockets mortos |
| `maxDurationMs` | `number` | desligado | Teto rígido para a vida de um stream; rede de segurança para ligações que nunca se desligam |

`realtimeSse(hub, options)` — o producer que passa ao `sse()`:

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `meta` | `ConnectionMeta` | — | `{ tenantId, userId?, id? }` da ligação — tire-o do contexto do pedido, nunca do cliente |
| `channels` | `readonly string[]` | — | Canais a juntar; cada um passa pelo `authorize` do hub, e uma recusa fecha o stream |
| `onOpen` | `(connection) => void \| Promise<void>` | — | Corre quando todos os canais estão juntos (p. ex. enviar um snapshot) |
| `maxBackpressure` | `number` | `50` | Envios consecutivos com o buffer cheio antes de fechar o stream; um envio que passa repõe a contagem |

`createRealtimeClient(options)`:

| Opção | Tipo | Predefinição | Para que serve |
| --- | --- | --- | --- |
| `url` | `string` | — | Endpoint WebSocket (`wss://…`) ou SSE |
| `transport` | `'websocket' \| 'sse'` | `'websocket'` | `'sse'` é só de receção: o cliente não pode pedir canais |
| `reconnect` | `false \| { minDelayMs?: number; maxDelayMs?: number }` | `{ minDelayMs: 500, maxDelayMs: 10_000 }` | Backoff exponencial com jitter; `false` para uma única tentativa |
| `WebSocketImpl` | `WebSocketCtor` | `globalThis.WebSocket` | Injeta uma implementação de socket (Node, testes) |
| `EventSourceImpl` | `EventSourceCtor` | `globalThis.EventSource` | Injeta uma implementação de `EventSource` |

## Modos de falha e resolução de problemas

O `@basaltkit/realtime` deliberadamente **não lança erros com código em runtime**:
um push é cosmético, por isso cada falha é reportada por callback e engolida em
vez de propagada. Estes são os sinais a vigiar:

| Falha | Aparece como | Comportamento predefinido | Quando |
| --- | --- | --- | --- |
| Broadcast da ponte rejeitado | `onBridgeError(error, { hook, channel, event })` | `console.error`, evento descartado | O backplane está em baixo/inacessível quando uma regra de ponte dispara |
| Evento da ponte sem tenant | `onBridgeSkipped({ hook, channel, event, reason: 'no-tenant' })` | `console.warn` uma vez por regra, evento descartado | Uma regra sem `tenant` disparou fora de um contexto com tenant (boot, cron, worker sem contexto) |
| Escrita local num socket lançou | `onDeliveryError(error, { connectionId, tenantId, channel, event })` | `console.error`, connection **removida e fechada**, restantes destinatários servidos na mesma | Um socket morreu entre a última escrita e esta |
| Payload não serializável em JSON | `emit()` / `hub.publish()` rejeita com `TypeError` (na ponte: `onBridgeError`) | nada é enviado, nenhum subscritor é afectado | `data` contém um `BigInt`, um ciclo, ou semelhante |
| Subscrição recusada | `hub.subscribe()` resolve `false` | nada — silencioso se não verificares | Id de connection desconhecido (ou fechou/foi substituído durante o `authorize`), canal não-string/vazio/demasiado longo, teto por connection atingido, ou `authorize` devolveu `false` |
| Payload malformado no backplane | `console.error` do driver Redis | mensagem descartada | Outra coisa fez `PUBLISH` no mesmo canal Redis, há incompatibilidade de versões, ou — com `secret` — a assinatura falta/é inválida ou as instâncias têm chaves diferentes |
| `UnknownTokenError` (`DI_UNKNOWN_TOKEN`) | lançado ao resolver | boot/pedido falha | `REALTIME` / `REALTIME_HUB` resolvido sem `realtimePlugin` registado |
| `Error: No WebSocket implementation; pass WebSocketImpl.` | lançado por `createRealtimeClient` | construção do cliente falha | A correr fora de um browser sem `WebSocketImpl`/`EventSourceImpl` injetado |

- **Os clientes ligam-se mas nunca recebem nada** — o tenant do emit não
  corresponde ao `tenantId` da connection, ou ninguém chamou `hub.subscribe`. Os
  canais são chaveados por `(tenantId, channel)`; um emit para `'acme'` é
  invisível para uma connection registada com `tenantId: 'Acme'`.
- **O `subscribe` não faz nada em silêncio** — devolveu `false`. Verifica primeiro
  o portão `authorize`, depois o comprimento do nome do canal e o teto por
  connection. Faz-lhe sempre `await`: é assíncrono, e uma chamada sem `await` é
  uma promessa flutuante.
- **Funciona numa instância, parte ao escalar para duas** — continuas no
  `MemoryBackplane` predefinido. Passa `RedisBackplane` com **dois** clientes; um
  único cliente reutilizado para publicar e subscrever falha assim que entra em
  modo de subscrição.
- **O `presence()` está vazio apesar de haver utilizadores ligados** — ou as
  connections foram registadas sem `userId`, ou esses utilizadores estão ligados a
  outro nó. A presença é por processo, por design.
- **A contagem de connections só cresce** — o `hub.unregister(conn.id)` não está
  ligado ao evento de fecho do socket. Só um `send` que *lança* remove uma
  connection automaticamente.
- **O processo não sai no encerramento** — o `RedisBackplane` não tem `close()`;
  termina tu os clientes ioredis depois do `app.shutdown()`.

Vê o [cookbook do SaaS de notas](/pt/cookbook/notes-saas) para a app envolvente, e
[Observabilidade](/pt/guide/observability) para pôres o `onBridgeError` /
`onDeliveryError` no teu logger em vez da consola.
