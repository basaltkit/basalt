# Perguntas frequentes (FAQ)

Respostas curtas às dúvidas que mais confundem — sobretudo *onde* é que os
snippets do resto da documentação vão parar no teu código.

## Onde é que `app.container.get()`, `ctx().container.get()` e `runWithContext()` vão?

A documentação mostra estes snippets mas raramente diz *onde* vivem, porque isso
depende de **onde o teu código está a correr**. Um app Basalt tem quatro zonas,
e cada snippet pertence a uma:

| Zona | Onde no teu código | O que usas | Tens `app`? | Tens `ctx()`? |
| --- | --- | --- | --- | --- |
| **1. Arranque** | o teu `server.ts` / um script | `app.container.get(X)` | ✅ | ❌ |
| **2. Dentro de um plugin** | `register({ container })` / `boot({ container })` | `container.get(X)` | ❌ | só em hooks |
| **3. Um handler de rota** (durante um pedido) | os teus handlers em `*.routes.ts` | `ctx().container.get(X)` | ❌ | ✅ |
| **4. Fora de um pedido** (script / job / teste) | scripts, workers, testes | `runWithContext(…)` | talvez | tu crias |

- **`app.container.get(X)`** só funciona onde o objeto `app` existe — logo a
  seguir a `createApp().boot()` (o arranque do teu servidor, um script pontual,
  um teste). **Não** está disponível dentro de um handler de rota.
- **`ctx().container.get(X)`** é como alcanças os mesmos serviços *durante um
  pedido*. A framework anexa ao `ctx()` um container com escopo do pedido.
- **`runWithContext(…)`** é só para código que corre **fora** de um pedido
  (um `node script.ts`, um worker de fila, um teste), onde tens de fornecer tu o
  `tenant` / `user` / `db`.

::: tip A regra de ouro
**Durante um pedido HTTP**, a framework já preparou tudo (`user`, `tenant`,
`container`, `db`) via os *enrichers* — por isso, num handler, só chamas `ctx()`
e **nunca** precisas de `runWithContext`.

**Fora de um pedido** ainda não há `ctx()` — então ou usas `app.container`
diretamente (para serviços que não precisam de tenant) ou envolves a chamada em
`runWithContext(…)` (para tudo o que é tenant-scoped).
:::

## Como uso um serviço (como o audit trail) dentro de um handler de rota?

Resolve-o a partir do container do pedido com `ctx()`. Já estás dentro de um
pedido, por isso o tenant/utilizador já estão definidos:

```ts
import { ctx, type Container } from '@basaltkit/core'
import { AUDIT } from '@basaltkit/audit'

route({
  method: 'GET',
  url: '/audit',
  meta: { auth: true },
  async handler() {
    const audit = (ctx().container as Container).get(AUDIT)
    return audit.trail() // já limitado ao tenant atual
  },
})
```

## Quando é que preciso mesmo de `runWithContext()`?

Só quando **não há um pedido** para te dar um contexto — e estás a chamar algo
que lê `ctx()` (a maioria dos serviços tenant-scoped lê). Casos típicos: um
script de CLI, um job agendado, um worker de fila, um seed, um teste.

```ts
import { runWithContext } from '@basaltkit/core'
import { buildApp } from '../src/app.js'
import { AUDIT } from '@basaltkit/audit'

const app = await buildApp().boot()          // zona 1 — tens o `app`
const audit = app.container.get(AUDIT)

// audit.trail() lê ctx().tenant, por isso dá-lhe um contexto primeiro:
await runWithContext({ tenant: { id: 'acme' }, container: app.container }, async () => {
  console.log(await audit.trail())           // agora sabe o tenant
})

await app.shutdown()
```

**Obter** o serviço (`.get(AUDIT)`) e **chamar** um método que lê `ctx()` são
coisas diferentes: dentro de um pedido o contexto já existe; num script crias-lo
com `runWithContext`.

## A minha query lança “no tenant in context” fora de um pedido — porquê?

Código tenant-scoped (a extensão de tenancy do Prisma, o `db()`, a maioria dos
stores) lê o tenant atual de `ctx().tenant`. Durante um pedido isso está definido
automaticamente. Num script ou worker não está — por isso envolve o trabalho em
`runWithContext({ tenant: { id }, db, container }, () => …)`, ou, para código
verdadeiramente central, usa um cliente/serviço que não seja tenant-scoped.

## Onde registo o meu próprio serviço ou token?

Num **plugin**. Cria um token tipado com `createToken` e liga uma factory no
`register` do plugin:

```ts
import { createToken, definePlugin } from '@basaltkit/core'

export const REPORTS = createToken<ReportService>('reports')

export const reportsPlugin = definePlugin({
  name: 'app:reports',
  register({ container }) {
    container.singleton(REPORTS, () => new ReportService())
  },
})
```

Depois disso, resolve-o em qualquer lado com `ctx().container.get(REPORTS)` (num
handler) ou `app.container.get(REPORTS)` (no arranque).
