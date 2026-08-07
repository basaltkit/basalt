# @machize/flags

Feature flags para o Machize: interruptores de funcionalidades que permitem ligar ou desligar partes da aplicação (para todos, para um cliente específico, para um utilizador, ou para uma percentagem gradual de pessoas) sem fazer deploy de código novo. Precisas deste módulo quando queres lançar funcionalidades com segurança e de forma controlada.

## O que este módulo resolve

Uma **feature flag** (bandeira de funcionalidade) é um interruptor no código: em vez de "esta funcionalidade existe para toda a gente assim que faço deploy", passas a ter "esta funcionalidade existe, mas só está ligada para quem eu decidir". Isto permite lançar um dashboard novo primeiro para um cliente-piloto, dar limites diferentes a planos diferentes, ou ativar uma novidade para 10% dos utilizadores e ir subindo com confiança.

Este módulo dá-te uma forma **tipada** (o TypeScript conhece o nome e o tipo de cada flag) de declarar flags com: um valor por omissão, exceções por **tenant** (cliente/organização numa aplicação SaaS), exceções por utilizador, **rollout percentual** (0–100% dos sujeitos, de forma determinística — o mesmo utilizador vê sempre o mesmo resultado, sem "piscar") e regras personalizadas em código.

E porque está integrado no Machize, a avaliação das flags usa automaticamente o **contexto do pedido atual**: se o pedido pertence ao tenant "acme" e ao utilizador "vip", basta perguntar `flags.enabled('novoDashboard')` — não precisas de passar quem é o utilizador, o framework já sabe. As flags não são só booleanas: podem ter qualquer tipo de valor (números, strings, objetos), o que serve para limites e configurações por plano.

## Instalação

```bash
pnpm add @machize/flags
```

Depende apenas de `@machize/core`. Não precisa de base de dados nem de serviços externos — as flags são definidas em código.

## Começar em 5 minutos

1. **Define as flags** com `defineFlags` — cada flag tem, no mínimo, um valor `default`.
2. **Regista o plugin** na aplicação.
3. **Avalia as flags** onde precisares.

```ts
import { createApp } from '@machize/core'
import { defineFlags, FLAGS, flagsPlugin } from '@machize/flags'

// 1. Define as flags (num ficheiro tipo src/flags.ts)
const flags = defineFlags({
  novoDashboard: { default: false, tenants: { acme: true } },
  maxUploadMb: { default: 10, tenants: { pro: 100 } },
  pesquisaBeta: { default: false, rollout: 25 }, // ligada para 25% dos utilizadores
})

// 2. Regista o plugin
const app = await createApp({
  plugins: [flagsPlugin(flags)],
}).boot()

// 3. Avalia — aqui com contexto explícito
console.log(flags.enabled('novoDashboard', { tenantId: 'acme' }))  // true
console.log(flags.enabled('novoDashboard', { tenantId: 'outro' })) // false
console.log(flags.value('maxUploadMb', { tenantId: 'pro' }))       // 100

await app.shutdown()
```

Dentro de um pedido HTTP não precisas de passar o contexto — a flag lê o tenant/utilizador do pedido atual:

```ts
// Numa rota/handler, com o tenant e o utilizador já no contexto do pedido:
if (flags.enabled('novoDashboard')) {
  // mostrar o dashboard novo
}
```

## Guia de utilização

### Valores por omissão e exceções por tenant/utilizador

Cada flag resolve para o valor **mais específico** disponível. A ordem de prioridade é:

1. `rule` (regra personalizada) — se devolver um valor
2. `users` — exceção para o utilizador atual
3. `tenants` — exceção para o tenant atual
4. `rollout` — percentagem (só para flags booleanas)
5. `default` — o valor base

```ts
import { defineFlags } from '@machize/flags'

const flags = defineFlags({
  maxUploadMb: {
    default: 10,
    tenants: { pro: 100 },  // clientes do plano "pro" têm 100 MB
    users: { vip: 500 },    // o utilizador "vip" tem 500 MB, esteja onde estiver
  },
})

flags.value('maxUploadMb', {})                                  // 10
flags.value('maxUploadMb', { tenantId: 'pro' })                 // 100
flags.value('maxUploadMb', { tenantId: 'pro', userId: 'vip' })  // 500 (utilizador ganha ao tenant)
```

Repara que as flags podem ser de **qualquer tipo** — esta é numérica. `flags.value(...)` devolve o tipo certo (aqui, `number`), inferido pelo TypeScript.

### Rollout percentual (lançamento gradual)

Para flags **booleanas**, `rollout: 25` liga a flag para 25% dos sujeitos. O sujeito é o `userId` (ou o `tenantId`, se não houver utilizador). A escolha é **determinística**: baseia-se num hash do par (nome da flag, sujeito), por isso o mesmo utilizador vê sempre o mesmo resultado — e distribuições diferentes por flag.

```ts
import { defineFlags } from '@machize/flags'

const flags = defineFlags({
  pesquisaBeta: { default: false, rollout: 50 },
})

// Estável: o mesmo utilizador recebe sempre a mesma resposta
flags.enabled('pesquisaBeta', { userId: 'user-1' }) // sempre igual para 'user-1'

// Sem sujeito (nem userId nem tenantId) o rollout não se aplica → usa o default
flags.enabled('pesquisaBeta', {}) // false
```

Para subir o rollout (25 → 50 → 100), basta alterar o número e fazer deploy: quem já estava incluído continua incluído.

### Regras personalizadas

Uma `rule` é uma função que recebe o contexto e devolve um valor (que vence tudo) ou `undefined` (que deixa a avaliação continuar para as camadas seguintes). O contexto aceita campos extra além de `tenantId`/`userId`:

```ts
import { defineFlags } from '@machize/flags'

const flags = defineFlags({
  lancamentoEuropa: {
    default: false,
    rule: (ctx) => (ctx['region'] === 'eu' ? true : undefined),
  },
})

flags.value('lancamentoEuropa', { region: 'eu' }) // true (a regra decidiu)
flags.value('lancamentoEuropa', { region: 'us' }) // false (a regra devolveu undefined → default)
```

### Avaliar com o contexto do pedido (automático)

Quando não passas contexto, a flag lê `tenant.id` e `user.id` do contexto do pedido atual (colocados lá pelos plugins de tenancy/auth):

```ts
import { runWithContext } from '@machize/core'
import { defineFlags } from '@machize/flags'

const flags = defineFlags({
  novoDashboard: { default: false, tenants: { acme: true } },
})

// Em testes/scripts simulas o contexto assim; nos pedidos HTTP é automático
const valor = await runWithContext({ tenant: { id: 'acme' } }, () =>
  flags.value('novoDashboard'),
)
console.log(valor) // true
```

### Resolver todas as flags de uma vez

Útil para enviar as flags ao frontend no arranque de uma sessão:

```ts
const todas = flags.all({ tenantId: 'acme', userId: 'u1' })
// { novoDashboard: true, maxUploadMb: 10, pesquisaBeta: false, … }
```

### Obter as flags pelo contentor

O plugin regista a instância sob o token `FLAGS`:

```ts
import { createApp } from '@machize/core'
import { FLAGS, flagsPlugin, defineFlags } from '@machize/flags'

const flags = defineFlags({ novoDashboard: { default: false } })
const app = await createApp({ plugins: [flagsPlugin(flags)] }).boot()

const instancia = app.container.get(FLAGS)
instancia.enabled('novoDashboard')
```

Nota: pelo token, o tipo genérico das flags é apagado (`FeatureFlags<FlagsShape>`) — para manter os nomes/tipos exatos das tuas flags, importa a instância criada com `defineFlags` diretamente do teu módulo.

## Referência da API

### `defineFlags(defs)`

`defineFlags<TShape extends FlagsShape>(defs: TShape): FeatureFlags<TShape>` — cria a instância tipada a partir de um objeto `{ nomeDaFlag: FlagDefinition }`.

### `interface FlagDefinition<T>`

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `default` | `T` | Sim | — | Valor quando nada mais se aplica. |
| `tenants` | `Record<string, T>` | Não | — | Exceções por id de tenant. |
| `users` | `Record<string, T>` | Não | — | Exceções por id de utilizador (ganham às de tenant). |
| `rollout` | `number` (0–100) | Não | — | Percentagem de sujeitos com a flag ligada. Só atua quando `default` é booleano e há `userId` ou `tenantId`. Determinístico por (flag, sujeito). |
| `rule` | `(context: FlagContext) => T \| undefined` | Não | — | Regra personalizada; um valor devolvido ganha a tudo, `undefined` passa à camada seguinte. |

### `class FeatureFlags<TShape>`

| Método | Assinatura | Descrição |
|---|---|---|
| `value` | `value<K extends keyof TShape>(key: K, context?: FlagContext): FlagValue<TShape[K]>` | Resolve a flag para o contexto dado (ou o do pedido atual). |
| `enabled` | `enabled<K extends keyof TShape>(key: K, context?: FlagContext): boolean` | `true` quando a flag resolve exatamente para `true`. |
| `all` | `all(context?: FlagContext): { [K in keyof TShape]: FlagValue<TShape[K]> }` | Resolve todas as flags de uma vez. |

### `type FlagContext`

`{ tenantId?: string; userId?: string } & Record<string, unknown>` — podes juntar campos teus (ex.: `region`) para usar em `rule`. Quando omitido, é preenchido a partir do contexto do pedido (`ctx().tenant.id` e `ctx().user.id`).

### `flagsPlugin(flags)`

`flagsPlugin<TShape>(flags: FeatureFlags<TShape> | TShape)` — aceita uma instância criada com `defineFlags` **ou** diretamente o objeto de definições; regista-a no contentor sob o token `FLAGS`.

### `FLAGS`

Token de injeção de dependências: `app.container.get(FLAGS)` devolve `FeatureFlags<FlagsShape>`.

### Tipos auxiliares (Avançado)

| Export | Descrição |
|---|---|
| `type FlagsShape` | `Record<string, FlagDefinition<unknown>>` — a forma do objeto de definições. |
| `type FlagValue<D>` | Extrai o tipo do valor de uma `FlagDefinition` (`FlagValue<FlagDefinition<T>>` = `T`). |

## Erros comuns e soluções (FAQ)

**O `rollout` não faz nada.**
Duas causas habituais: (1) a flag não é booleana — o rollout só atua quando `default` é `true`/`false`; (2) não há sujeito — sem `userId` nem `tenantId` no contexto, a flag cai no `default`. Confirma que o pedido tem utilizador ou tenant identificado (ou passa-os explicitamente).

**Defini `tenants: { acme: true }` mas dentro do pedido a flag vem `false`.**
O contexto do pedido não tem o tenant. Verifica que o plugin de tenancy está configurado e identifica o tenant antes de avaliares a flag, ou passa `{ tenantId: 'acme' }` explicitamente.

**A minha `rule` devolve `false` e esperava que caísse no override de tenant.**
`false` é um valor válido — só `undefined` deixa a avaliação continuar. Se queres "não decidir", devolve `undefined`.

**Posso mudar uma flag sem fazer deploy?**
Neste módulo as definições vivem no código, portanto mudar valores implica deploy. O que evitas é deploy de *funcionalidade*: o código novo já lá está, e a flag controla quem o vê. Para valores dinâmicos em runtime, usa uma `rule` que consulte a tua própria fonte (base de dados, config remota).

**`app.container.get(FLAGS)` perdeu os tipos das minhas flags.**
Comportamento esperado: o token é genérico. Importa a instância de `defineFlags` do teu módulo para teres autocompletar e tipos exatos.

**Mudei o nome de uma flag e o rollout "baralhou" quem estava incluído.**
O bucket determinístico depende do nome da flag — renomear redistribui os sujeitos. Evita renomear flags com rollout a meio.

## Como se liga aos outros módulos

- **`@machize/core`** — fornece o `createApp`, o contentor, os tokens e o contexto de pedido de onde vêm `tenantId`/`userId` automáticos.
- **`@machize/tenancy`** e **`@machize/auth`** — são estes plugins que colocam `tenant` e `user` no contexto de cada pedido; com eles ativos, `flags.enabled('x')` funciona sem contexto explícito.
- **`@machize/subscriptions`** — padrão comum: usar uma `rule` para ligar funcionalidades ao plano de subscrição do tenant.
- **`@machize/http` / adaptadores web** — típico expor uma rota que devolve `flags.all()` ao frontend no arranque da sessão.
