# Tarefas agendadas

O [`@basaltkit/scheduler`](/reference/packages/scheduler) corre trabalho **num
agendamento** — backups noturnos, relatórios semanais, billing mensal — declarado em
código legível em vez de cron cru. O scheduler acorda uma vez por minuto, verifica o
que está "due", e corre-o.

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
`shutdown`. `daily`/`weekly`/`monthly` combinam com `at('HH:mm')`; `weekly` corre ao
domingo, `monthly` no dia 1. Inspeciona o registo com `app.container.get(SCHEDULER).list()`.

## Fusos horários, sobreposição & falhas

Agendamentos reais precisam de mais do que uma hora — o módulo trata das arestas:

```ts
schedule.call('digest', sendDigest)
  .daily().at('07:00').timezone('Europe/Lisbon')  // hora local, não a do servidor
  .withoutOverlapping()                            // salta se a execução anterior ainda corre
  .onFailure((err) => report(err))                 // handler de erro por tarefa
```

Sem `onFailure`, os erros são agregados sem crashar o processo. Precisas de cron cru?
`schedule.call('x', fn).cron('*/5 * * * *')` é o escape hatch.

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
