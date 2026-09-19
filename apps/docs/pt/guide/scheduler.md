# Tarefas agendadas

O [`@basaltkit/scheduler`](/reference/packages/scheduler) corre trabalho **num
agendamento** — backups noturnos, relatórios semanais, billing mensal — declarado em
código legível em vez de cron cru. O scheduler acorda uma vez por minuto, verifica o
que está "due", e corre-o.

[[toc]]

## Como funciona um tick

No `boot` o plugin corre o teu callback `define`, regista as entradas e alinha
um timer ao próximo minuto. A cada 60 segundos corre um **tick**:

1. Seleciona as entradas cujo cron corresponde ao minuto atual, avaliado no
   `timezone` de cada entrada (predefinição UTC).
2. Para uma entrada `.onOneServer()`, adquire a chave de lock entre réplicas
   `basalt:schedule:<name>:<minuto ISO>` — exatamente uma réplica a obtém; as
   outras saltam este minuto (contado em `scheduler.skippedByLock`).
3. Para uma entrada `.withoutOverlapping()` cuja execução anterior ainda corre,
   salta (contado em `entry.skippedOverlaps`).
4. Corre a tarefa. Um erro vai para o handler `onFailure` da entrada; sem um, as
   falhas do tick são agregadas num `AggregateError` — todas as entradas due
   correm na mesma, e o processo nunca crasha porque uma tarefa lançou.

O scheduler falha **alto e cedo** sempre que pode: uma expressão cron inválida
lança `CronParseError` no momento da definição, uma entrada com duas
frequências (ou um `.at()` mal formado) lança `ScheduleDefinitionError` no boot,
`.onOneServer()` sem lock falha o boot, e uma falha do lock store conta como
falha da tarefa — nunca um no-op silencioso.

## Definir agendamentos

Regista o plugin e declara as tarefas com uma API fluente:

```ts
import { createApp } from '@basaltkit/core'
import { schedulerPlugin, SCHEDULER } from '@basaltkit/scheduler'

const app = await createApp({
  plugins: [
    schedulerPlugin({
      define: (schedule) => {
        schedule.call('heartbeat', () => log('alive'))          // a cada minuto

        schedule.call('backup', doBackup).daily().at('03:00')   // 03:00 todos os dias

        schedule.call('weekly-report', sendReport)
          .weekly().at('09:00')                                 // domingos às 09:00

        schedule.call('close-billing', closeBilling)
          .monthly().at('00:00')                                // dia 1 do mês
      },
    }),
  ],
}).boot()
```

Não há passo de arranque — o timer alinha-se ao próximo minuto no `boot` e para no
`shutdown`. Inspeciona o registo com `app.container.get(SCHEDULER).list()`.

Todos os builders de entrada, num relance:

| Builder | Efeito |
| --- | --- |
| `.everyMinute()` | A cada minuto (a predefinição). |
| `.everyMinutes(n)` | Minutos divisíveis por `n` (`*/n`). |
| `.hourly()` | Minuto 0 de cada hora. |
| `.daily()` / `.weekly()` / `.monthly()` | 00:00 diariamente / aos domingos / no dia 1 — combina com `.at()`. |
| `.at('HH:mm')` | Define a hora. Só com `daily`/`weekly`/`monthly` (ou sem frequência, o que significa diário), uma vez por entrada. |
| `.sundays()` … `.saturdays()` | Fixa o dia da semana. Não com `.cron()`. |
| `.cron('*/5 * * * *')` | Cron cru de 5 campos — o escape hatch, validado no momento da definição. É a frequência da entrada. |
| `.timezone('Europe/Lisbon')` | Avalia o cron nessa zona IANA. Predefinição `UTC`. |
| `.withoutOverlapping()` | Salta uma execução enquanto a anterior ainda corre (este processo). |
| `.onOneServer()` | Corre numa réplica por tick — requer um `lock` (abaixo). |
| `.onFailure(handler)` | Handler de erro por tarefa — sem ele, as falhas são agregadas por tick. |

`schedule.call(name, fn)` corre uma função; `schedule.job(JobDef, payload?)`
despacha um [job de queue](/pt/guide/queues) em vez disso (vê abaixo).

### Uma frequência por entrada

`everyMinute`, `everyMinutes`, `hourly`, `daily`, `weekly`, `monthly` e `cron`
são **frequências**, e uma entrada tem exatamente uma. Uma segunda lança
`ScheduleDefinitionError` (código `SCHEDULE_CONFLICT`) enquanto o `define` corre,
por isso a app falha no boot em vez de correr, sem aviso, com a última chamada:

```ts
schedule.call('backup', doBackup).daily().monthly()
// ✗ Schedule "backup": .monthly() conflicts with .daily() — an entry has one
//   frequency. Use .monthly().at('HH:mm') instead.

schedule.call('backup', doBackup).monthly().at('03:00')  // ✓ uma frequência + uma hora
```

O `.at('HH:mm')` refina uma frequência, por isso as combinações válidas são:

| Cadeia | Válida? |
| --- | --- |
| `.daily().at()` / `.weekly().at()` / `.monthly().at()` | ✓ |
| `.at()` sem frequência, ou antes de `daily`/`weekly`/`monthly` | ✓ (a ordem não importa) |
| `.weekly().mondays().at('07:30')` | ✓ |
| `.everyMinute()` / `.everyMinutes(n)` / `.hourly()` / `.cron()` + `.at()` | ✗ `SCHEDULE_CONFLICT` |
| `.at()` duas vezes | ✗ `SCHEDULE_CONFLICT` |
| `.cron()` + `.mondays()` (em qualquer ordem) | ✗ `SCHEDULE_CONFLICT`: põe o dia na expressão |
| `.at('25:00')`, `.at('ab')` | ✗ `SCHEDULE_INVALID_TIME`: hora 0–23, minuto 0–59 |

## Fusos horários, sobreposição & falhas

Agendamentos reais precisam de mais do que uma hora — o módulo trata das arestas:

```ts
schedule.call('digest', sendDigest)
  .daily().at('07:00').timezone('Europe/Lisbon')  // hora local, não a do servidor
  .withoutOverlapping()                            // salta se a execução anterior ainda corre
  .onFailure((err) => report(err))                 // handler de erro por tarefa
```

Sem `onFailure`, os erros são agregados sem crashar o processo. Precisas de cron cru?
`schedule.call('x', fn).cron('*/5 * * * *')` é o escape hatch — a expressão é
validada no momento da definição (sintaxe suportada: `*`, `*/n`, valores únicos,
intervalos `a-b`, listas com vírgulas; nomes como `MON` são rejeitados com um
`CronParseError` em vez de nunca dispararem silenciosamente).

## Múltiplas réplicas: `.onOneServer()`

`withoutOverlapping()` protege UM processo. Num deployment escalado
horizontalmente cada réplica tem o seu próprio scheduler, por isso uma entrada
`daily()` simples corre em todos os pods — N× a tua reconciliação de billing.
Marca a entrada com `.onOneServer()` e dá ao plugin um lock atómico entre
réplicas (qualquer store com set-if-absent + TTL; Redis como exemplo):

```ts
import { schedulerPlugin, type ScheduleLock } from '@basaltkit/scheduler'

const lock: ScheduleLock = {
  async acquire(key, ttlMs) {
    return (await redis.set(key, '1', 'PX', ttlMs, 'NX')) === 'OK'
  },
}

schedulerPlugin({
  lock,
  define: (schedule) => {
    schedule.job(ReconcileBilling).daily().at('03:00').onOneServer()
  },
})
```

O contrato `ScheduleLock` é um método — `acquire(key, ttlMs)` — e tem de ser
**atómico entre processos** (set-if-absent, como o `SET key value PX ttl NX` do
Redis): retorna `true` para exatamente um chamador por chave até o TTL expirar.
O scheduler constrói uma chave **por entrada e por minuto**
(`basalt:schedule:<name>:<minuto ISO>`), pelo que exatamente uma réplica corre a
entrada e as outras saltam esse tick (visível em `scheduler.skippedByLock`).
Deliberadamente não há `release`: a chave cobre a janela inteira do tick, para
que uma primeira execução rápida não possa ser seguida por uma réplica atrasada
a readquirir e a correr o mesmo minuto outra vez.

Duas regras fail-closed mantêm isto honesto:

- **`.onOneServer()` sem `lock` falha alto no boot** — correr silenciosamente em
  todas as réplicas é precisamente o modo de falha que isto existe para prevenir.
- **Uma falha do lock store (p. ex. Redis em baixo) conta como falha da tarefa**
  — visível via `onFailure`/o `AggregateError` do tick — em vez de ser tratada
  como permissão para todas as réplicas correrem ao mesmo tempo.

Triggers manuais (`runNow`, `basalt schedule:run`) ignoram o lock de propósito —
um trigger manual é deliberado.

## Integração com queue & testes

Passa trabalho pesado a uma queue em vez de o correr inline — `schedule.job(...)`
despacha um job [`@basaltkit/queue`](/pt/guide/queues) quando a entrada está due:

```ts
schedule.job(GenerateReport, { month: '2026-01' }).monthly().at('02:00')
```

Como o agendamento é baseado no tempo, testar é determinista: chama `tick(date)` com
uma data fixa e verifica que entradas correram — sem esperar por relógios reais.

```ts
scheduler.tick(new Date('2026-01-01T03:00:00Z')) // corre tudo o que está due nesse minuto
```

## Recuperar trabalho encalhado: `defineReconciler()`

Se um dispatch falha **depois** do commit de negócio, ou um worker morre a meio de um job, a
entidade fica num estado intermédio (`processing`) para sempre. `defineReconciler` monta a rede
de segurança sobre o scheduler: numa cadência, encontra os itens encalhados e volta a despachá-los.

```ts
import { defineReconciler } from '@basaltkit/scheduler'

schedulerPlugin({
  define: (schedule) => {
    defineReconciler({
      name: 'stuck-orders',
      every: '5m',                   // ou uma expressão cron
      find: () => prisma.order.findMany({
        where: { status: 'processing', updatedAt: { lt: new Date(Date.now() - 15 * 60_000) } },
        take: 500,
      }),
      redispatch: (order) => ProcessOrder.dispatch({ orderId: order.id }), // tem de ser idempotente
      maxPerRun: 100,
      onError: (error, order) => logger.error({ err: error, orderId: order?.id }, 'reconcile failed'),
    }).schedule(schedule)
  },
})
```

- **Sem sobreposição** — uma execução nunca começa enquanto a anterior ainda corre (o tick é
  saltado e contado em `reconciler.stats.skippedOverlaps`). Com um `lock` no scheduler a entrada
  corre numa só réplica por tick; `lock: ReconcilerLock` (`acquire` + `release`) segura ainda um
  mutex distribuído durante toda a execução.
- **Isolamento por item** — um `redispatch` que lança vai para `onError(error, item)` e o item
  seguinte corre na mesma; um `find` que lança vai para `onError(error, undefined)`.
  Predefinição: `console.error`.
- **Observável** — cada execução emite o hook `reconciler:run` no bus da app com
  `{ name, found, redispatched, failed, skipped, reason?, error?, durationMs }`; `onRun(result)`
  dá os mesmos dados como callback.
- `every` aceita minutos inteiros que dividem 60, horas inteiras que dividem 24, `'1d'` ou uma
  expressão cron; qualquer outra coisa lança `ScheduleDefinitionError`
  (`SCHEDULE_INVALID_INTERVAL`) no boot.

A entrada chama-se `reconciler:<name>`, por isso `basalt schedule:run reconciler:stuck-orders`
corre-a a pedido. A tabela completa de opções está no
[README do pacote](https://github.com/basaltkit/basalt/tree/main/packages/scheduler#definereconcilert-options-reconcileroptionst-reconciler).

## Correr a pedido

`schedule:run` dispara uma entrada a partir da CLI, ignorando o seu cron — para
testar um agendamento ou repetir um que falhou:

```bash
basalt schedule:run close-billing   # corre uma entrada agora
basalt schedule:run --due           # corre tudo o que está due neste minuto
```

Programaticamente, `scheduler.runNow(name)` faz o mesmo (retorna `false` para um
nome desconhecido). Ambos ignoram o lock de `.onOneServer()` — o guard de
sobreposição e o handler `onFailure` da entrada continuam a aplicar-se.

## Referência de opções

`schedulerPlugin(options)`:

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `define` | `(schedule: Scheduler) => void` | — | Declara as entradas no boot. |
| `autostart` | `boolean` | `true` | Arranca o timer de minuto no boot. Define `false` em testes e chama `tick(date)` tu próprio. |
| `lock` | `ScheduleLock` | — | Lock atómico set-if-absent entre réplicas. **Obrigatório** assim que alguma entrada usa `.onOneServer()` — o boot falha sem ele. |
| `lockTtlMs` | `number` | `60_000` | TTL de cada chave de lock por entrada e por minuto. Uma janela de tick — a chave embute o minuto, por isso só precisa de sobreviver ao desvio de relógio entre réplicas. |

## Modos de falha e resolução de problemas

| Se vires | Significa | Faz |
| --- | --- | --- |
| O boot lança `schedulerPlugin: an entry uses .onOneServer() but no 'lock' was configured.` | Guard fail-closed: sem lock a entrada correria silenciosamente em todas as réplicas | Passa `schedulerPlugin({ lock })` com um lock atómico set-if-absent |
| `CronParseError` (código `CRON_INVALID`) na definição | A expressão cron usa sintaxe não suportada (nomes como `MON`), um valor fora do intervalo, ou um intervalo invertido — de outro modo nunca dispararia, silenciosamente | Corrige a expressão; suportado: `*`, `*/n`, valores únicos, `a-b`, listas com vírgulas |
| `ScheduleDefinitionError` (código `SCHEDULE_CONFLICT`) no boot | Uma entrada encadeia duas frequências (`.daily().monthly()`), usa `.at()` depois de `everyMinute`/`everyMinutes`/`hourly`/`cron` ou duas vezes, ou combina `.cron()` com um modificador de dia da semana. Antes, a última chamada ganhava silenciosamente | Mantém a frequência que queres, p. ex. `.monthly().at('03:00')`; para o resto usa só `.cron()` |
| `ScheduleDefinitionError` (código `SCHEDULE_INVALID_TIME`) no boot | O `.at()` recebeu algo que não é `HH:mm` (hora 0–23, minuto 0–59) | Corrige a hora, p. ex. `.at('03:00')` |
| `ScheduleDefinitionError` (código `SCHEDULE_INVALID_INTERVAL`) no boot | O `every` de um reconciler não cabe no cron baseado em minutos (`'30s'`, `'7m'`, `'90m'`) | Usa `'1m'`, `'5m'`, `'15m'`, `'2h'`, `'1d'` ou uma expressão cron |
| `AggregateError: Failure in N scheduled task(s)` | Tarefas sem `onFailure` lançaram durante um tick; todas as entradas due correram na mesma e o processo sobreviveu | Adiciona `.onFailure()` para encaminhar os erros de cada tarefa para o teu reporting |
| Uma tarefa corre N vezes ao mesmo tempo entre pods | Falta `.onOneServer()` na entrada (ou as réplicas apontam para lock stores diferentes) | Marca-a `.onOneServer()`; partilha um lock store entre réplicas |
| Uma tarefa `.onOneServer()` falhou o tick enquanto o Redis esteve em baixo | Fail closed: uma falha do lock store é uma falha da tarefa, nunca permissão para correr em todo o lado | Restaura o lock store; o tick do minuto seguinte recupera |
| Uma tarefa saltou um minuto silenciosamente | Guard de sobreposição ou lock: verifica os contadores `entry.skippedOverlaps` e `scheduler.skippedByLock` | Comportamento esperado — alarga o intervalo se as execuções se sobrepõem por rotina |
| `Unknown scheduled task "x"` do `schedule:run` | O nome não corresponde a nenhuma entrada | O `basalt schedule:run` imprime os nomes disponíveis — usa um deles |

## Ver também

- [Queues e jobs](/pt/guide/queues) — para onde `schedule.job(...)` despacha.
