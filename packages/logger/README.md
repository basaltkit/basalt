# @machize/logger

Logging estruturado para aplicações Machize, construído sobre o [pino](https://getpino.io): cada linha de log sai em JSON, enriquecida automaticamente com o contexto do pedido (`requestId`, `tenantId`, `userId`) e com dados sensíveis (passwords, tokens) censurados por omissão.

Precisas deste módulo assim que quiseres perceber o que a tua aplicação anda a fazer — em desenvolvimento e, sobretudo, em produção.

---

## O que este módulo resolve

Um **log** é o diário da aplicação: cada acontecimento relevante ("utilizador entrou", "pagamento falhou") é escrito numa linha. Com `console.log` essas linhas são texto solto, difícil de pesquisar. O **logging estruturado** escreve cada linha como JSON — um formato com campos (`{"level":30,"msg":"login ok","userId":"u-9"}`) que ferramentas como Datadog, Loki ou CloudWatch conseguem filtrar e agregar.

O problema seguinte é a **correlação**: quando dez pedidos correm ao mesmo tempo, como sabes que linhas pertencem ao mesmo pedido? Este módulo lê o contexto ativo da aplicação (o "request context" do `@machize/core`, guardado em AsyncLocalStorage) e acrescenta **automaticamente** `requestId`, `correlationId`, `traceId`, `userId` e `tenantId` a cada linha — sem tu passares nada nas chamadas de log. Se o contexto tiver objetos `tenant`/`user` com `id`, eles tornam-se `tenantId`/`userId`.

Por fim, a **segurança**: é demasiado fácil despejar uma password ou um token para os logs por acidente. Por omissão, campos como `password`, `token`, `secret` e `authorization` (a qualquer profundidade de um nível: `*.password`, etc.) são substituídos por `[REDACTED]`.

## Instalação

```bash
pnpm add @machize/logger
```

Depende de `@machize/core` e `pino`. Para saída legível em desenvolvimento (`pretty: true`), instala também o `pino-pretty`:

```bash
pnpm add -D pino-pretty
```

## Começar em 5 minutos

**1. Regista o plugin:**

```ts
import { createApp } from '@machize/core'
import { LOGGER, loggerPlugin } from '@machize/logger'

const app = await createApp({
  plugins: [loggerPlugin({ level: 'info' })],
}).boot()
```

**2. Obtém o logger do contentor e usa-o:**

```ts
const logger = app.container.get(LOGGER)

logger.info('aplicação arrancou')
logger.info({ port: 3000 }, 'servidor a ouvir')      // campos extra + mensagem
logger.warn({ quota: 0.9 }, 'quota quase esgotada')
logger.error({ err: new Error('boom') }, 'falhou')
```

Saída (JSON, uma linha por chamada):

```json
{"level":30,"time":1754500000000,"msg":"servidor a ouvir","port":3000}
```

**3. Dentro de um pedido com contexto, os campos aparecem sozinhos:**

```ts
import { runWithContext } from '@machize/core'

runWithContext({ requestId: 'req-1', tenant: { id: 't-acme' }, user: { id: 'u-9' } }, () => {
  logger.info('dentro do pedido')
  // → {"msg":"dentro do pedido","requestId":"req-1","tenantId":"t-acme","userId":"u-9",...}
})
```

(Numa aplicação real é o middleware HTTP que faz o `runWithContext` por ti.)

## Guia de utilização

### Criar um logger sem plugin

`createLogger` devolve um logger pino normal — usa-o em scripts, testes ou fora do contentor:

```ts
import { createLogger } from '@machize/logger'

const logger = createLogger({ level: 'debug', base: { service: 'api' } })
logger.debug('a arrancar')
```

### Níveis de log

Os níveis do pino, do mais falador ao mais grave: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. A opção `level` define o mínimo emitido — com `level: 'warn'`, chamadas `info` e `debug` são descartadas:

```ts
import { createLogger } from '@machize/logger'

const logger = createLogger({ level: 'warn' })
logger.info('não aparece')
logger.warn('aparece')
```

### Saída legível em desenvolvimento

```ts
import { createLogger } from '@machize/logger'

const logger = createLogger({ pretty: true }) // requer pino-pretty instalado
```

Em produção deixa `pretty` desligado — o JSON é o formato que os agregadores esperam.

### Censura (redaction) de dados sensíveis

Por omissão são censurados: `password`, `*.password`, `token`, `*.token`, `secret`, `*.secret`, `authorization`, `*.authorization`, `headers.authorization`. Podes acrescentar caminhos:

```ts
import { createLogger } from '@machize/logger'

const logger = createLogger({ redact: ['creditCard', '*.creditCard'] })
logger.info({ email: 'a@b.c', password: '123', auth: { token: 'jwt' } }, 'login')
// → {"msg":"login","email":"a@b.c","password":"[REDACTED]","auth":{"token":"[REDACTED]"}}
```

Nota: os caminhos extra **somam-se** aos default, não os substituem.

### Child loggers (sub-loggers por módulo)

Um *child logger* herda a configuração e acrescenta campos fixos — útil para identificar o módulo:

```ts
const subscriptionsLogger = logger.child({ pkg: 'subscriptions' })
subscriptionsLogger.warn('quota baixa')
// → {"msg":"quota baixa","pkg":"subscriptions", ...contexto ativo...}
```

O enriquecimento de contexto continua a funcionar nos child loggers.

### Capturar a saída em testes

A opção `destination` aceita qualquer stream com `write(msg)` — nos testes, captura as linhas e faz asserções:

```ts
import { createLogger } from '@machize/logger'

const lines: Record<string, unknown>[] = []
const logger = createLogger({
  destination: { write: (msg: string) => void lines.push(JSON.parse(msg)) },
})

logger.info({ pkg: 'core' }, 'boot ok')
// lines[0] → { msg: 'boot ok', pkg: 'core', ... }
```

## Referência da API

### `createLogger(options?: LoggerOptions): Logger`

Cria um logger pino com contexto automático e redaction. `Logger` é um alias do logger pino (`PinoLogger<string, boolean>`) — tens toda a API pino: `info/warn/error/debug/trace/fatal`, `child()`, `flush()`, etc.

`LoggerOptions`:

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `level` | `string` | Não | `'info'` | Nível mínimo emitido (`trace`…`fatal`). |
| `pretty` | `boolean` | Não | `false` (JSON) | Saída colorida e legível para dev — requer `pino-pretty` instalado. |
| `redact` | `string[]` | Não | `[]` | Caminhos de censura **extra**, somados aos default. Censor: `[REDACTED]`. |
| `base` | `Record<string, unknown>` | Não | `{}` | Campos fixos em todas as linhas (ex.: `{ service: 'api' }`). Nota: o default `{}` remove os campos `pid`/`hostname` que o pino normalmente inclui. |
| `destination` | `DestinationStream` | Não | stdout | Stream de destino — usado em testes para capturar a saída. |

Campos de contexto promovidos automaticamente para cada linha (quando existe contexto ativo): `requestId`, `correlationId`, `traceId`, `userId`, `tenantId`; e ainda `tenant.id` → `tenantId`, `user.id` → `userId` (sem sobrepor valores já presentes no contexto).

### `loggerPlugin(options?: LoggerOptions)`

Plugin Machize: regista `createLogger(options)` como singleton no token `LOGGER`; no `shutdown` chama `logger.flush()` para escoar buffers. Aceita exatamente as mesmas opções que `createLogger`.

```ts
import { LOGGER, loggerPlugin } from '@machize/logger'
// registo:  plugins: [loggerPlugin({ level: 'info' })]
// obtenção: const logger = app.container.get(LOGGER)
```

### Exports

| Export | Tipo | Descrição |
|---|---|---|
| `createLogger` | função | Cria um logger. |
| `loggerPlugin` | função | Plugin para `createApp`. |
| `LOGGER` | `Token<Logger>` | Token de injeção do logger no contentor. |
| `Logger` | tipo | Alias do logger pino. |
| `LoggerOptions` | tipo | Opções (tabela acima). |

## Erros comuns e soluções (FAQ)

**Ativei `pretty: true` e rebentou com "unable to determine transport target for pino-pretty".**
O `pino-pretty` não está instalado. Corre `pnpm add -D pino-pretty`, ou remove `pretty` (produção deve usar JSON).

**As linhas não trazem `requestId`/`tenantId`.**
Esses campos só existem quando há **contexto ativo** — código a correr dentro de `runWithContext(...)` (normalmente o middleware HTTP trata disso). Fora de um pedido, é normal não aparecerem.

**O meu `logger.info(...)` não imprime nada.**
O nível está acima da chamada (ex.: `level: 'warn'` descarta `info`). Baixa o `level` ou sobe a severidade da chamada.

**Vejo `[REDACTED]` num campo que não é sensível.**
O nome do campo coincide com um caminho default (ex.: qualquer `token` de topo ou `*.token`). Renomeia o campo (ex.: `inviteTokenId`) — os defaults não são removíveis via opções, apenas acrescentáveis.

**Qual é a diferença entre `logger.info('msg')` e `logger.info({ a: 1 }, 'msg')`?**
Convenção pino: o **primeiro** argumento pode ser um objeto de campos extra; a mensagem vem a seguir. `logger.info('msg', { a: 1 })` está errado — o objeto seria interpolado na mensagem.

**Perdi logs no fim do processo.**
Termina a aplicação com `app.shutdown()` — o plugin chama `flush()` no shutdown.

## Como se liga aos outros módulos

- **`@machize/core`** — fonte do contexto (AsyncLocalStorage via `runWithContext`/`tryCtx`) que enriquece cada linha; o `loggerPlugin` usa `definePlugin`/`createToken` do core.
- **`@machize/queue`** — a fila propaga o contexto do pedido para os workers; logs escritos dentro de um `handle` de job saem com o `requestId`/`tenantId` do pedido que o despachou — correlação ponta a ponta.
- **`@machize/scheduler`** — usa o logger dentro das tarefas agendadas e dos handlers `onFailure` para rasto das execuções periódicas.
- **`@machize/audit` / `@machize/activity`** — papéis diferentes: o logger é diagnóstico técnico (efémero, para operadores); a auditoria e a atividade são registos de negócio (persistentes, para compliance e para o utilizador final). Usa os três em conjunto.
