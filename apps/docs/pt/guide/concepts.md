# Conceitos Fundamentais

Tudo no Basalt é construído sobre uma base pequena: uma aplicação com um ciclo
de vida de plugins, um container de injeção de dependências, e um contexto de
pedido que flui por toda a call stack.

## A aplicação

O `createApp` monta os plugins e arranca-os por ordem de dependência.

```ts
import { createApp } from '@basaltkit/core'

const app = await createApp({
  plugins: [configPlugin, loggerPlugin, tenancyPlugin, authPlugin],
}).boot()

// ... mais tarde, encerramento gracioso (ordem inversa do boot)
await app.shutdown()
```

## Plugins

Um plugin é a unidade de composição — cada pacote envia um. Os plugins declaram
as suas dependências, registam serviços e ligam recursos.

```ts
import { definePlugin, createToken } from '@basaltkit/core'

export const MAILER = createToken<Mailer>('mailer')

export const mailerPlugin = definePlugin({
  name: 'basalt:mailer',
  dependsOn: ['basalt:config'],
  register({ container, config }) {
    container.singleton(MAILER, () => new SmtpMailer(config))
  },
  async shutdown({ container }) {
    await container.get(MAILER).close()
  },
})
```

O `dependsOn` produz uma ordem de boot topológica; um ciclo é um erro de
arranque que nomeia o ciclo.

## Injeção de dependências sem decorators

O container usa **tokens tipados e factory functions** — sem decorators, sem
`reflect-metadata`. Isso significa que funciona em qualquer bundler e runtime, o
grafo de dependências é explícito, e o tree-shaking funciona.

```ts
const mailer = container.get(MAILER) // totalmente tipado, sem reflexão
```

## Contexto (AsyncLocalStorage)

O `ctx()` devolve o contexto de pedido/job ativo em qualquer ponto da call stack
— handlers, serviços, jobs, listeners — sem passar parâmetros. Carrega o request
id, o correlation id, o tenant atual, o utilizador autenticado e o cliente de
base de dados com escopo.

```ts
import { ctx } from '@basaltkit/core'

export async function anyService() {
  const { tenant, user, logger, db } = ctx()
  logger.info('processing') // já etiquetado com tenantId + requestId
}
```

Esta é a espinha dorsal que permite a cache, storage, queue, logger e Prisma
isolarem-se por tenant automaticamente — todos lêem o tenant a partir do
contexto, por isso o teu código nunca o passa à mão.

## Hooks (HookBus)

Onde o container partilha *serviços*, o **HookBus** partilha *momentos*. Permite
a um plugin anunciar que algo aconteceu e a outros reagir — sem que nenhum deles
importe o outro. Cada app carrega um em `app.hooks`, e cada plugin recebe-o no
seu contexto de ciclo de vida. A própria app emite `app:registered`,
`app:booted` e `app:shutdown`; os pacotes adicionam os seus próprios hooks
tipados via module augmentation (a auth emite
`auth:password_reset_requested`, e por aí adiante).

```ts
import { definePlugin } from '@basaltkit/core'

export const emailOnResetPlugin = definePlugin({
  name: 'app:reset-email',
  dependsOn: ['basalt:auth'],
  boot({ hooks }) {
    // subscreve na fase de boot; `on` devolve uma função de cancelamento
    hooks.on('auth:password_reset_requested', async ({ user, token }) => {
      await sendEmail(user.email, `https://app.example.com/reset?token=${token}`)
    })
  },
})
```

O `hooks.on(hook, handler, { priority })` corre primeiro os handlers de maior
prioridade; o `hooks.emit(hook, payload)` corre-os **em série**, aguardando cada
um; e o `hooks.onAny((hook, payload) => …)` vê cada emissão depois dos handlers
específicos — as devtools de hooks e o trilho de auditoria dependem disso.

::: tip Dica: Hooks vs. eventos
**Hooks** (`@basaltkit/core`) são pontos de extensão da framework — momentos
internos em que os plugins se ligam. **Eventos** (`@basaltkit/events`, abaixo)
são os eventos do teu *domínio*, validados com Zod e destinados à lógica da
aplicação.
:::

## Eventos

Os eventos de domínio são tipados e desacoplados. Preocupações transversais como
a auditoria subscrevem com wildcards em vez de tocar em cada call site.

```ts
import { defineEvent, on } from '@basaltkit/events'
import { z } from 'zod'

export const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))

on(OrderCreated, async ({ orderId }) => { /* ... */ })
on('order.*', auditListener) // wildcard
```
