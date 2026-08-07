# @machize/scheduler

Agendador de tarefas para aplicações Machize: define, com uma API fluente e legível (`daily().at('03:00')`), tarefas que correm automaticamente em horários certos — backups, relatórios, limpezas, faturação.

Precisas deste módulo sempre que quiseres que algo aconteça **num horário**, e não em resposta a um pedido do utilizador.

---

## O que este módulo resolve

Muitas aplicações precisam de trabalho periódico: apagar sessões expiradas todas as noites, enviar um resumo semanal ao domingo, fechar a faturação no dia 1 de cada mês. A forma tradicional de o fazer é o **cron** — um formato de 5 campos (`minuto hora dia-do-mês mês dia-da-semana`, ex.: `0 3 * * *` = "todos os dias às 03:00") que é poderoso mas fácil de escrever mal.

Este módulo deixa-te declarar os horários em código legível — `schedule.call('backup', fazerBackup).daily().at('03:00')` — sem decorares a sintaxe cron (embora também a aceite como "escape hatch"). O agendador acorda **uma vez por minuto**, verifica que entradas estão "devidas" nesse minuto e executa-as.

Além disso trata dos problemas chatos: **fusos horários** (agenda às 03:00 de Lisboa ou de São Paulo, não do servidor), **sobreposição** (se a execução anterior ainda estiver a decorrer, salta a nova com `withoutOverlapping()`), **falhas** (handler `onFailure` por entrada; sem ele, o erro é agregado sem derrubar o processo) e **testabilidade** (o método `tick(data)` é determinístico — nos testes chamas-lo com uma data fixa, sem esperar por relógios).

## Instalação

```bash
pnpm add @machize/scheduler
```

Depende de `@machize/core` e integra-se (opcionalmente) com `@machize/queue`.

## Começar em 5 minutos

**1. Regista o plugin e define os agendamentos** (ex.: `src/app.ts`):

```ts
import { createApp } from '@machize/core'
import { schedulerPlugin } from '@machize/scheduler'

const app = await createApp({
  plugins: [
    schedulerPlugin({
      define: (schedule) => {
        // todos os minutos
        schedule.call('heartbeat', () => console.log('ainda vivo'))

        // todos os dias às 03:00 UTC
        schedule
          .call('backup', async () => {
            // fazer o backup…
          })
          .daily()
          .at('03:00')
      },
    }),
  ],
}).boot()
```

**2. Não há passo 2.** No `boot`, o plugin chama o teu `define`, e o temporizador interno arranca sozinho (alinha ao próximo minuto e depois verifica a cada 60 segundos). No `shutdown` da aplicação, o temporizador para.

Para veres o que está agendado:

```ts
import { SCHEDULER } from '@machize/scheduler'

console.log(app.container.get(SCHEDULER).list())
// [{ name: 'heartbeat', cron: '* * * * *', timezone: 'UTC' },
//  { name: 'backup',    cron: '0 3 * * *', timezone: 'UTC' }]
```

## Guia de utilização

### Frequências fluentes

Cada método devolve a própria entrada, por isso encadeiam-se:

```ts
import { Scheduler } from '@machize/scheduler'

const schedule = new Scheduler()

schedule.call('a', task).everyMinute()          // * * * * *
schedule.call('b', task).everyMinutes(15)       // */15 * * * *
schedule.call('c', task).hourly()               // 0 * * * *   (ao minuto 0)
schedule.call('d', task).daily()                // 0 0 * * *   (meia-noite)
schedule.call('e', task).daily().at('03:30')    // 30 3 * * *
schedule.call('f', task).weekly()               // 0 0 * * 0   (domingo à meia-noite)
schedule.call('g', task).weekly().sundays().at('08:00') // 0 8 * * 0
schedule.call('h', task).monthly().at('00:30')  // 30 0 1 * *  (dia 1 do mês)
schedule.call('i', task).mondays().at('09:00')  // dias da semana: sundays()…saturdays()
```

`at('HH:mm')` combina com `daily()`/`weekly()`/`monthly()` — define a hora e o minuto.

### Expressão cron direta

Quando o fluente não chega, passa cron cru (5 campos; suporta `*`, passos `*/n`, intervalos `a-b` e listas `a,b,c`):

```ts
// a cada 15 minutos, das 9h às 17h, de segunda a sexta
schedule.call('sync', sincronizar).cron('*/15 9-17 * * 1-5')
```

Uma expressão inválida lança `CronParseError` (código `CRON_INVALID`).

### Fusos horários

Por omissão os horários são interpretados em **UTC**. Usa `timezone()` com um nome IANA:

```ts
schedule
  .call('relatorio', gerarRelatorio)
  .daily()
  .at('03:00')
  .timezone('America/Sao_Paulo') // 03:00 em São Paulo = 06:00 UTC
```

### Evitar sobreposição: `withoutOverlapping()`

Se uma tarefa demora mais do que o intervalo entre execuções, a nova execução é **saltada** enquanto a anterior decorre:

```ts
const entry = schedule
  .call('importacao-lenta', importarTudo)
  .everyMinute()
  .withoutOverlapping()

// entry.skippedOverlaps conta as execuções saltadas (observabilidade/testes)
```

### Tratar falhas: `onFailure()`

```ts
schedule
  .call('fragil', tarefaQuePodefalhar)
  .hourly()
  .onFailure((error) => {
    console.error('tarefa falhou', error)
  })
```

- **Com** `onFailure`: o erro é entregue ao handler e não se propaga.
- **Sem** `onFailure`: no `tick()` manual, os erros das entradas devidas são agregados num `AggregateError` (todas as entradas devidas correm na mesma). No modo automático (timer), a falha é engolida para não derrubar o processo — por isso, em produção, define sempre `onFailure` (ou usa `schedule.job(...)`, ver abaixo, e deixa os retries para a fila).

### Agendar jobs da fila: `schedule.job()`

Em vez de executar a tarefa no processo do agendador, podes agendar o **dispatch** de um job `@machize/queue` — o trabalho pesado corre no worker, com retries e contexto:

```ts
import { createApp } from '@machize/core'
import { defineJob, queuePlugin } from '@machize/queue'
import { schedulerPlugin } from '@machize/scheduler'
import { z } from 'zod'

const ReconcileBilling = defineJob({
  name: 'billing.reconcile',
  schema: z.object({ mode: z.string() }),
  async handle({ mode }) { /* reconciliar… */ },
})

const app = await createApp({
  plugins: [
    queuePlugin({ jobs: [ReconcileBilling] }),
    schedulerPlugin({
      define: (schedule) => {
        schedule.job(ReconcileBilling, { mode: 'full' }).daily().at('03:00')
      },
    }),
  ],
}).boot()
```

A entrada fica com o nome do job (`billing.reconcile`). Se o job não recebe payload (`T = void`), chama-se apenas `schedule.job(MeuJob)`.

### Testar de forma determinística

`tick(date)` executa tudo o que está devido nesse instante exato — sem timers reais:

```ts
import { Scheduler } from '@machize/scheduler'

const scheduler = new Scheduler()
let runs = 0
scheduler.call('backup', () => void runs++).daily().at('03:00')

await scheduler.tick(new Date('2026-08-05T10:15:00Z')) // não é 03:00 → não corre
await scheduler.tick(new Date('2026-08-05T03:00:00Z')) // corre
console.log(runs) // 1
```

Nos testes com o plugin, passa `autostart: false` para o timer não arrancar.

## Referência da API

### `schedulerPlugin(options?: SchedulerPluginOptions)`

Regista um `Scheduler` (singleton) no token `SCHEDULER`; no `boot` chama `define`, publica as entradas nos metadados do contentor (chave `schedule:entries`, consumida pela CLI `mach schedule:list`) e arranca o timer; no `shutdown` chama `stop()`.

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `define` | `(schedule: Scheduler) => void` | Não | — | Callback onde declaras os agendamentos (recebe o Scheduler no boot). |
| `autostart` | `boolean` | Não | `true` | Arranca o timer no boot. Desliga em testes. |

### `class Scheduler`

| Método | Assinatura | Descrição |
|---|---|---|
| `call` | `(name: string, task: () => void \| Promise<void>) => ScheduleEntry` | Agenda uma função com um nome. |
| `job` | `<T>(job: JobDefinition<T>, payload?) => ScheduleEntry` | Agenda o `dispatch` de um job `@machize/queue` (payload obrigatório se o job o exigir). |
| `list` | `() => { name, cron, timezone }[]` | Descreve todas as entradas. |
| `tick` | `(date?: Date) => Promise<void>` | Executa as entradas devidas nesse instante (default: agora). Agrega falhas sem `onFailure` em `AggregateError`. |
| `start` | `() => void` | Alinha ao próximo minuto e depois faz `tick()` a cada 60 s. Idempotente. |
| `stop` | `() => void` | Para os temporizadores. |

### `class ScheduleEntry` (devolvida por `call`/`job`)

Métodos de frequência (todos devolvem `this`): `everyMinute()`, `everyMinutes(n)`, `hourly()`, `daily()`, `weekly()`, `monthly()`, `at('HH:mm')`, `cron(expression)`, `sundays()`, `mondays()`, `tuesdays()`, `wednesdays()`, `thursdays()`, `fridays()`, `saturdays()`.

| Método/propriedade | Tipo | Default | Descrição |
|---|---|---|---|
| `timezone(tz)` | `(tz: string) => this` | `'UTC'` | Fuso IANA em que o horário é interpretado. |
| `withoutOverlapping()` | `() => this` | desligado | Salta a execução se a anterior ainda decorre. |
| `onFailure(handler)` | `((error: unknown) => void) => this` | — | Recebe o erro em vez de o propagar. |
| `describe()` | `() => { name, cron, timezone }` | — | Descrição da entrada. |
| `isDue(date)` | `(date: Date) => boolean` | — | A entrada está devida neste instante? |
| `skippedOverlaps` | `number` | `0` | Contador de execuções saltadas por sobreposição. |
| `run()` | `() => Promise<void>` | — | **Avançado/interno**: executa com guarda de overlap e tratamento de falha. |

Sem qualquer método de frequência, a entrada corre **todos os minutos** (campos cron iniciais são `* * * * *`).

### Utilitários cron (Avançado)

Exportados para tooling e testes; normalmente não precisas deles:

| Export | Assinatura | Descrição |
|---|---|---|
| `parseCron` | `(expression: string) => CronFields` | Divide uma expressão de 5 campos; lança `CronParseError` se inválida. |
| `cronMatches` | `(fields: CronFields, date: Date, timeZone?: string) => boolean` | O instante corresponde à expressão (no fuso dado)? |
| `fieldMatches` | `(field: string, value: number) => boolean` | Um campo (`*`, `*/n`, `a-b`, `a,b,c`, valor) aceita o número? |
| `zonedParts` | `(date: Date, timeZone = 'UTC') => ZonedParts` | Decompõe o instante em minuto/hora/dia/mês/dia-da-semana no fuso. |
| `CronParseError` | classe (`MachizeError`, código `CRON_INVALID`) | Expressão cron inválida. |
| `CronFields`, `ZonedParts` | tipos | Campos cron como strings; partes numéricas do instante. |

### Token

- `SCHEDULER: Token<Scheduler>` — para obter o Scheduler do contentor: `app.container.get(SCHEDULER)`.

## Erros comuns e soluções (FAQ)

**A minha tarefa `daily().at('03:00')` corre à hora errada.**
Os horários são UTC por omissão. Acrescenta `.timezone('Europe/Lisbon')` (ou o teu fuso IANA).

**`CronParseError: expected 5 fields`.**
O `cron()` só aceita o formato clássico de 5 campos (`min hora dia mês dia-semana`). Formatos de 6 campos (com segundos) não são suportados.

**A tarefa corre duas vezes (dois servidores).**
O agendador corre em cada processo onde o plugin arranca. Se tens várias réplicas, ativa o scheduler só numa (ex.: variável de ambiente) ou agenda `schedule.job(...)` com jobs idempotentes.

**Uma tarefa falhou e não vi nada.**
No modo automático, falhas sem `onFailure` são silenciadas para não derrubar o processo. Define `onFailure` em cada entrada (ou faz log lá dentro).

**Preciso de precisão ao segundo.**
Não é possível — a resolução é o minuto (o `tick` corre a cada 60 s), como no cron clássico.

**Nos testes, o processo não termina.**
Passa `autostart: false` ao plugin, ou chama `scheduler.stop()`. (Os timers usam `unref()`, por isso normalmente não seguram o processo, mas em testes convém não os arrancar.)

## Como se liga aos outros módulos

- **`@machize/core`** — o `schedulerPlugin` é um plugin core (register/boot/shutdown); as entradas são publicadas no registo de metadados do contentor (`ensureMetadata` → chave `schedule:entries`) para a CLI `mach schedule:list`; `CronParseError` estende `MachizeError`.
- **`@machize/queue`** — `schedule.job(MeuJob, payload)` agenda o *dispatch* de um job: o agendador só coloca na fila; a execução, retries e contexto ficam a cargo da fila e dos workers. É o padrão recomendado para tarefas pesadas ou críticas.
- **`@machize/logger`** — usa o logger dentro das tarefas/`onFailure` para teres rasto estruturado das execuções.
- **`@machize/audit` / `@machize/activity`** — tarefas agendadas podem registar entradas de auditoria ou atividade (ex.: `audit.record('maintenance.run')`) para deixares rasto do trabalho automático.
