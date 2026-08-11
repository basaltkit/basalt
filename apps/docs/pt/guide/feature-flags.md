# Feature Flags

O `@basaltkit/flags` avalia flags contra um contexto — recorrendo ao tenant e ao
utilizador do pedido atual — com targeting por tenant/utilizador e rollouts
percentuais determinísticos. Zero dependências, totalmente tipado.

[[toc]]

## Definir

```ts
// src/flags.ts
import { defineFlags } from '@basaltkit/flags'

export const flags = defineFlags({
  newDashboard: { default: false, tenants: { acme: true } },
  maxUploadMb:  { default: 10, tenants: { pro: 100 }, users: { vip: 500 } },
  betaSearch:   { default: false, rollout: 20 },              // 20% dos sujeitos
  euOnly:       { default: false, rule: (ctx) => ctx.region === 'eu' || undefined },
})
```

`rule` recebe o `FlagContext` completo — `{ tenantId?, userId? }` mais quaisquer
chaves extra que passes no momento da avaliação (`region` acima). Devolver
`undefined` passa para o passo de resolução seguinte.

## Ligar a uma app

Regista a instância tipada com `flagsPlugin` para que qualquer código a possa
resolver do container sob o token `FLAGS`:

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { FLAGS, flagsPlugin } from '@basaltkit/flags'
import { flags } from './flags.js'

const app = await createApp({
  plugins: [flagsPlugin(flags)],
}).boot()

const resolved = app.container.get(FLAGS)
resolved.enabled('betaSearch', { userId: 'vip' }) // contexto explícito
```

::: tip Dica: mantém o autocompletion
O token `FLAGS` apaga os tipos das chaves do catálogo. Importa a tua instância
`flags` tipada diretamente (como acima) — ou faz cast do valor resolvido — para
manter o autocompletion das chaves e a inferência de valores em
`enabled`/`value`/`all`.
:::

## Avaliar

Dentro de um pedido, o tenant e o utilizador vêm do contexto automaticamente —
sem plumbing por chamada:

```ts
import { flags } from './flags.js' // a instância tipada mantém o autocompletion das chaves

flags.enabled('newDashboard')          // usa o tenant/utilizador do pedido atual
flags.value('maxUploadMb')             // → 100 para o tenant "pro", 500 para o utilizador "vip"
flags.enabled('betaSearch', { userId: 'u1' }) // override de contexto explícito
flags.value('euOnly', { region: 'eu' })        // chave de contexto custom lida por `rule`
flags.all()                            // resolve tudo — ex. para semear um cliente
```

## De ponta a ponta: proteger uma rota e semear o cliente

```ts
import { z } from 'zod'
import { route } from '@basaltkit/fastify'
import { HttpError } from '@basaltkit/fastify'
import { flags } from './flags.js'

// Proteger uma rota de servidor — o contexto (tenant/utilizador) é implícito no handler.
export const dashboard = route({
  method: 'GET',
  url: '/dashboard',
  handler() {
    if (!flags.enabled('newDashboard')) throw new HttpError(404, 'Not found')
    return { layout: 'v2', maxUploadMb: flags.value('maxUploadMb') }
  },
})

// Fazer bootstrap do browser: resolve tudo uma vez e envia-o para o cliente.
export const bootstrap = route({
  method: 'GET',
  url: '/bootstrap',
  handler: () => ({ flags: flags.all() }),
})
```

## Ordem de resolução

O mais específico ganha:

1. **`rule`** — um predicado custom (devolve `undefined` para passar adiante)
2. **`users[userId]`** — override explícito por utilizador
3. **`tenants[tenantId]`** — override explícito por tenant
4. **`rollout`** — bucket determinístico para flags booleanas (um sujeito recebe
   sempre a mesma resposta, por isso um rollout é estável à medida que alarga)
5. **`default`**

Como a avaliação lê o contexto do pedido automaticamente, a mesma chamada
`flags.enabled('x')` devolve a resposta certa por tenant sem plumbing.
