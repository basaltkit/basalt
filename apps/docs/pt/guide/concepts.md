# Conceitos Fundamentais

Tudo no Basalt assenta numa fundação pequena: uma aplicação com um ciclo de
vida de plugins, um container de injeção de dependências, um contexto de pedido
que flui por toda a call stack, e um punhado de **buckets de metadata com
chaves string** que permitem aos packages cooperar sem se importarem uns aos
outros. Esta página é a referência oficial desses internos — suficiente para
escrever um package Basalt de terceiros só com os docs.

[[toc]]

## A aplicação

`createApp` monta os plugins e arranca-os por ordem de dependências.

```ts
import { createApp } from '@basaltkit/core'

const app = await createApp({
  plugins: [configPlugin, loggerPlugin, tenancyPlugin, authPlugin],
}).boot()

// ... mais tarde, shutdown gracioso (ordem inversa do boot)
await app.shutdown()
```

`app.container` é o container DI raiz; `app.hooks` é o `HookBus` partilhado.
`dependsOn` produz uma ordem de boot topológica; um ciclo é um erro de arranque
que nomeia o ciclo.

## Plugins — a unidade de composição

Um plugin é o que cada package fornece. Declara dependências, regista serviços
e liga recursos — em **três fases**:

| Fase | Quando | O que pertence aqui | O que NÃO pode acontecer aqui |
|---|---|---|---|
| `register` | para todos os plugins, antes de qualquer `boot` | bindings no container (`container.singleton(...)`), contribuições de metadata (`ensureMetadata(container).add(...)`) | **Nenhum I/O, nenhum efeito colateral** — sem ligações, sem listeners, sem resolver serviços de outros plugins |
| `boot` | depois de todos os plugins registarem, por ordem de dependências | ligar recursos, subscrever hooks, arrancar servidores/workers | registar novos bindings que outros plugins deviam ter visto |
| `shutdown` | ordem inversa do boot | fechar ligações, fazer flush de buffers | — |

```ts
import { definePlugin, createToken, ensureMetadata } from '@basaltkit/core'

export const MAILER = createToken<Mailer>('mailer')

export const mailerPlugin = definePlugin({
  name: 'basalt:mailer',        // convenção: basalt:<package> ou app:<name>
  dependsOn: ['basalt:config'], // arranca depois do config
  register({ container, config }) {
    container.singleton(MAILER, () => new SmtpMailer(config))
  },
  async shutdown({ container }) {
    await container.get(MAILER).close()
  },
})
```

Cada fase recebe um `PluginContext`: `{ container, hooks, config }`. Um
`configSchema` opcional (qualquer coisa com a forma `safeParse` do Zod) valida
a fatia de config do plugin no boot — falha cedo, antes do tráfego.

::: warning A regra da fase register é estrutural
O `register` corre para **todos** os plugins antes de qualquer `boot`. A
metadata escrita no `register` (guards, enrichers, claims) tem visibilidade
garantida para todo o consumidor que a leia no `boot` — é dessa ordem que todo
o modelo de cooperação abaixo depende. Um plugin que faça I/O ou resolva
serviços no `register` quebra essa garantia para todos.
:::

## Injeção de dependências sem decorators

O container usa **tokens tipados e funções factory** — sem decorators, sem
`reflect-metadata`. O grafo de dependências é explícito, funciona em qualquer
bundler e runtime, e faz tree-shaking.

```ts
import { createToken } from '@basaltkit/core'

const REPORTS = createToken<Reports>('reports')          // Token<Reports>
container.singleton(REPORTS, (c) => new Reports(c.get(MAILER)))
const reports = container.get(REPORTS)                    // totalmente tipado
```

### Lifetimes

| Lifetime | Registado com | Uma instância por… | Uso típico |
|---|---|---|---|
| `singleton` | `container.singleton(token, factory)` | aplicação | serviços, drivers, clients |
| `scoped` | `container.scoped(token, factory)` | scope de pedido (`createScope()`) | estado por pedido, client de BD por pedido |
| `transient` | `container.transient(token, factory)` | resolução — instância nova em cada `get()` | helpers sem estado |

`container.has(token)` verifica alcançabilidade; `container.createScope()`
abre um scope filho (o pipeline HTTP faz isto por pedido — raramente o chamas
tu). As factories recebem o container **que resolve**, por isso uma resolução
scoped dentro de um pedido vê o scope desse pedido.

### Os lifetimes são impostos — `DI_CAPTIVE_DEPENDENCY`

Um `singleton` sobrevive a todos os scopes de pedido, por isso a sua factory
não pode resolver tokens `scoped` — isso congelaria a instância de um pedido
num serviço app-wide (o utilizador do pedido 1 a vazar para todos os pedidos
seguintes). O container falha alto com `CaptiveDependencyError` (código
`DI_CAPTIVE_DEPENDENCY`) em vez de capturar silenciosamente. Resolve serviços
dependentes de scope no **momento do uso** (via `ctx().container`) e não na
construção:

```ts
// ❌ lança DI_CAPTIVE_DEPENDENCY no boot — token scoped dentro de factory singleton
container.singleton(REPORTS, (c) => new Reports(c.get(REQUEST_USER)))

// ✅ resolve por uso, dentro do pedido
container.singleton(REPORTS, () => new Reports(() => ctx().container.get(REQUEST_USER)))
```

### Inspecionar o container (devtools)

```ts
import { renderDependencyGraph } from '@basaltkit/core'

container.describe()      // cada binding alcançável: token, lifetime, construído?
container.enableGraph()   // opt-in; overhead zero quando desligado
// … arranca a app / corre alguns pedidos …
const graph = container.dependencyGraph()  // { nodes, edges } observados até agora
console.log(renderDependencyGraph(graph))  // Mermaid — cola em qualquer viewer
```

`describe()` é um snapshot estático; o grafo de dependências é **passivo** —
regista resoluções reais `A depende de B` desde o `enableGraph()` e nunca força
construção antecipada.

## Contexto (AsyncLocalStorage)

`ctx()` devolve o contexto ativo do pedido/job em qualquer ponto da call
stack — handlers, serviços, jobs, listeners — sem passar parâmetros. Transporta
o id do pedido, o correlation id, o tenant atual, o utilizador autenticado, o
container scoped e o client de base de dados scoped.

```ts
import { ctx, tryCtx, runWithContext } from '@basaltkit/core'

export async function anyService() {
  const { tenant, user, logger } = ctx() // lança ContextUnavailableError fora de um contexto
  logger.info('processing')              // já etiquetado com tenantId + requestId
}

tryCtx()                                  // …ou undefined fora de um contexto, sem lançar
await runWithContext({ tenant }, () => runJobForTenant()) // dá contexto a trabalho em background
```

Esta é a espinha dorsal que permite a cache, storage, queue, logger e drivers
de dados isolarem por tenant automaticamente — todos leem o tenant do contexto,
por isso o teu código nunca o passa à mão. Jobs em background correm **fora**
do contexto de pedido: envolve-os em `runWithContext` quando agem por um tenant
específico (packages tenant-scoped falham fechados sem isso — p.ex. a cache
lança `MissingCacheScopeError` em apps multi-tenant; vê
[Caching](/pt/guide/caching)).

## Buckets de metadata — como os packages cooperam

Um `MetadataRegistry` vive no container raiz (`ensureMetadata(container)`),
com duas operações: `add(bucket, entry)` e `get<T>(bucket): T[]`. Os buckets
são **strings simples**, por isso os packages contribuem e consomem pontos de
extensão uns dos outros com zero acoplamento de imports. Estes são os buckets
oficiais:

| Bucket | Tipo de entrada | Escrito por | Lido por |
|---|---|---|---|
| `http:enrichers` | `RequestEnricher` | tenancy, auth, qualquer construtor de contexto | os adapters HTTP (cada pedido, antes dos guards) |
| `http:guards` | `RouteGuard` | auth, permissions, teams, os teus plugins | os adapters HTTP (cada pedido, depois dos enrichers) |
| `http:guarded-meta` | `string` (uma chave de meta) | cada plugin cujo guard **aplica** uma chave de meta de segurança | o check de boot dos adapters (abaixo) |
| `http:routes` | descritores de rota | os adapters no boot | OpenAPI, a CLI (`basalt routes`), o SDK |
| `commands` | `CommandDefinition` (estrutural) | qualquer package com comandos CLI | `@basaltkit/cli` |
| `schedule:entries` | descritores de agendamento | o scheduler | tooling CLI `schedule:list` |
| `tenancy:active` | `true` | `tenancyPlugin` | packages que adotam defaults tenant-safe (primeiro consumidor: cache) |

Contribui no `register`, consome no `boot` — a ordem das fases garante a
visibilidade.

## O pipeline neutro de rotas

As rotas definem-se uma vez com `route()` de `@basaltkit/http` e correm de
forma idêntica em Fastify, Express e Hono — os adapters traduzem o seu
request/reply nativo para uma forma neutra e chamam o mesmo `runRoute`. Por
pedido, por ordem:

1. **Contexto de pedido** criado (request id, correlation id) com um
   **container scoped** novo (`createScope()`).
2. **Enrichers** correm (`http:enrichers`) — constroem o contexto: a tenancy
   define `ctx().tenant`, a auth define `ctx().user`. Um enricher recebe
   `{ request, context, container }`.
3. **Guards** correm (`http:guards`) — autorizam: um guard recebe
   `{ route, request, context, container }`, lê o `meta` da rota e rejeita
   **lançando**. A auth lê `meta.auth`, as permissions leem `meta.can`, os
   teams leem `meta.teamRole`, as API keys leem `meta.scopes` e as
   subscrições leem `meta.subscribed`/`meta.feature`.
4. **Validação** — `body`, `query` e `params` passam por `safeParse` contra os
   schemas Zod da rota; uma falha é um `RequestValidationError`
   (`HTTP_VALIDATION`, 400) com issues por campo.
5. **Handler** corre com as partes tipadas e validadas.
6. **Resposta** — o valor devolvido é enviado (a menos que o handler já tenha
   respondido); ETags/304 são tratados; rotas sem match recebem o corpo 404
   neutro partilhado (`NOT_FOUND_RESPONSE`:
   `{ error: { code: 'NOT_FOUND', … } }`) em todos os adapters.

### O modelo de erros

Todos os erros da framework estendem `BasaltError` — `code` (estável, legível
por máquina) mais `message`. Erros virados ao HTTP transportam um `status`;
`toErrorResponse` mapeia qualquer erro lançado para o corpo padrão
`{ error: { code, message, … } }`. Lança `HttpError(status, code, message)`
para erros HTTP intencionais em qualquer camada. Erros
desconhecidos/inesperados tornam-se 500 **sem vazar a mensagem interna**. Os
códigos que encontras nestes docs são reais e estáveis — p.ex. `AUTH_REQUIRED`,
`PERMISSION_DENIED`, `PERMISSION_META_INVALID`, `TENANT_REQUIRED`,
`TEAM_NOT_A_MEMBER`, `DI_CAPTIVE_DEPENDENCY`, `HTTP_VALIDATION`, `NOT_FOUND` —
trata-os como API.

### Meta de segurança tem de ser aplicada — o check de boot

`meta: { auth: true }`, `meta.can`, `meta.teamRole`, `meta.scopes`,
`meta.subscribed` e `meta.feature` são *pedidos* de proteção;
o guard que um plugin regista é o que os aplica. No boot, os adapters
verificam que cada chave de meta de segurança declarada tem um guard registado
a reclamá-la (via `http:guarded-meta`) e recusam arrancar caso contrário
(`UnguardedRouteMetaError`), listando todas as rotas em falta. Válvula de
escape para deployments autenticados na edge:
`allowUnguardedMeta: true | ['auth', …]` no plugin do adapter. Detalhes em
[Segurança](/pt/guide/security).

## Escrever o teu próprio guard ou enricher

Um package de terceiros completo que protege rotas com `meta.approved`:

```ts
import { definePlugin, ensureMetadata } from '@basaltkit/core'
import { HttpError, type RequestEnricher, type RouteGuard } from '@basaltkit/http'

export const approvalPlugin = definePlugin({
  name: 'acme:approval',
  register({ container }) {
    const metadata = ensureMetadata(container)

    // Enricher: o contexto constrói-se aqui, nunca nos guards.
    const enricher: RequestEnricher = async ({ request, context }) => {
      ;(context as { approved?: boolean }).approved =
        request.headers['x-approval'] === 'granted'
    }
    metadata.add('http:enrichers', enricher)

    // Guard: lê o meta da rota, rejeita lançando.
    const guard: RouteGuard = ({ route, context }) => {
      if (route.meta?.['approved'] === true && !(context as { approved?: boolean }).approved) {
        throw new HttpError(403, 'APPROVAL_REQUIRED', 'This action needs approval.')
      }
    }
    metadata.add('http:guards', guard)
  },
})
```

Regras do jogo: os enrichers **constroem** contexto, os guards **decidem** —
mantém os dois separados; os guards têm de ser baratos (correm em cada pedido
com match) e têm de **falhar fechados** (uma declaração não aplicável é um
erro, não um salto); se o teu guard aplica uma das chaves de segurança da
framework, reclama-a — `metadata.add('http:guarded-meta', '<chave>')` — para o
check de boot saber.

## O contrato de adapter

Um package adapter HTTP (o que `@basaltkit/fastify`, `express` e `hono` fazem —
e o que um novo tem de fazer):

1. `register`: liga o servidor nativo sob o seu token, e um
   `HttpServerCollector` sob `HTTP_SERVER` (os edge plugins — security headers,
   rate limits — contribuem hooks pre/after através dele).
2. `boot`: lê `http:enrichers` + `http:guards`, corre o check de boot
   `assertRoutesGuarded`, regista cada rota para que os pedidos fluam pelo
   `runRoute` neutro (contexto → enrichers → guards → validação → handler),
   publica descritores em `http:routes`, monta os edge hooks do collector no
   `app:booted`, e serve o 404 neutro.
3. `shutdown`: fecha o servidor.

As features apontam ao contrato neutro, nunca a um adapter — um teste de
fronteira no CI garante que packages de features runtime não importam um
adapter.

## Hooks (HookBus)

Onde o container partilha *serviços*, o **HookBus** partilha *momentos*. Um
plugin anuncia que algo aconteceu; outros reagem — sem se importarem uns aos
outros. Cada app transporta um em `app.hooks`, e cada plugin recebe-o no seu
contexto de ciclo de vida. A app emite `app:registered`, `app:booted`,
`app:shutdown`; os packages acrescentam os seus próprios hooks tipados por
module augmentation (a auth emite `auth:password_reset_requested`, os teams
emitem `team:joined`, etc. — o guia de cada package lista os seus hooks).

```ts
import { definePlugin } from '@basaltkit/core'

export const emailOnResetPlugin = definePlugin({
  name: 'app:reset-email',
  dependsOn: ['basalt:auth'],
  boot({ hooks }) {
    // subscreve na fase boot; `on` devolve uma função de unsubscribe
    hooks.on('auth:password_reset_requested', async ({ user, token }) => {
      await sendEmail(user.email, `https://app.example.com/reset?token=${token}`)
    })
  },
})
```

`hooks.on(hook, handler, { priority })` corre primeiro os handlers de
prioridade mais alta; `hooks.emit(hook, payload)` espera os handlers **em
série**; e `hooks.onAny((hook, payload) => …)` vê todas as emissões depois dos
handlers específicos — os devtools de hooks e a audit trail penduram-se daí.

**Os handlers são isolados.** A falha de um handler nunca priva os handlers
restantes nem os observadores `onAny` — todos os handlers registados correm
sempre. As falhas ainda chegam ao emissor no fim: uma falha única relança o
erro original, várias tornam-se um `AggregateError`. Nada é engolido em
silêncio. (Listeners cosméticos — pushes de realtime, notificações — desacoplam
adicionalmente com fire-and-log para nunca poderem falhar uma escrita de
domínio; vê [Realtime](/pt/guide/realtime).)

::: tip Hooks vs. eventos
**Hooks** (`@basaltkit/core`) são pontos de extensão da framework — momentos
internos a que os plugins se ligam. **Eventos** (`@basaltkit/events`, abaixo)
são os teus eventos de *domínio*, validados com Zod e destinados à lógica da
aplicação.
:::

## Eventos

Os eventos de domínio são tipados e desacoplados. Preocupações transversais
como o audit subscrevem com wildcards em vez de tocar em cada call site.

```ts
import { defineEvent, on } from '@basaltkit/events'
import { z } from 'zod'

export const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))

on(OrderCreated, async ({ orderId }) => { /* ... */ })
on('order.*', auditListener) // wildcard
```

Para entrega durável, at-least-once (um evento que tem de sobreviver a um
crash entre a escrita e a publicação), emparelha o bus com o **outbox** — vê
[Persistência](/pt/guide/persistence).

## Troubleshooting

| Vês | Significa | Faz |
|---|---|---|
| `DI_CAPTIVE_DEPENDENCY` no boot | uma factory singleton resolveu um token `scoped` | resolve no momento do uso via `ctx().container` (vê [Lifetimes](#os-lifetimes-sao-impostos-di-captive-dependency)) |
| `UnguardedRouteMetaError` no boot | uma rota declara uma chave guardada (`meta.auth`/`can`/`teamRole`/`scopes`/`subscribed`/`feature`) mas o plugin que aplica não está registado | regista `authPlugin`/`permissionsPlugin`/`teamsPlugin`, ou opta por sair com `allowUnguardedMeta` |
| `ContextUnavailableError` | `ctx()` chamado fora de qualquer contexto de pedido/job | usa `tryCtx()`, ou envolve trabalho em background em `runWithContext` |
| erro de boot do plugin a nomear um ciclo | o `dependsOn` forma um loop | quebra o ciclo — normalmente movendo uma subscrição do `register` para o `boot` |
| `HTTP_VALIDATION` (400) | o body/query/params do pedido falhou o schema Zod da rota | a resposta lista a parte que falhou e as issues por campo |
