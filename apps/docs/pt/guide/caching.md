# Caching

`@basaltkit/cache` é um cache scoped por tenant com tags, TTL e proteção contra
stampede, sobre um driver plugável — em memória para dev, Redis para produção, ou um
driver multinível que coloca um near cache à frente do Redis.

[[toc]]

## Setup

`cachePlugin` regista um `Cache` sob o token `CACHE`. Começa no driver em memória
(sem servidor necessário):

```ts
import { createApp } from '@basaltkit/core'
import { cachePlugin, CACHE } from '@basaltkit/cache'

const app = await createApp({
  plugins: [cachePlugin({ driver: 'memory' })], // 'memory' é a predefinição
}).boot()

const cache = app.container.get(CACHE)
await cache.put('greeting', 'hello world', '10m')
console.log(await cache.get('greeting')) // 'hello world'
```

Cada chave é prefixada com o tenant de `ctx().tenant`, por isso os tenants nunca veem
as entradas uns dos outros. `cache.flush()` limpa apenas as chaves deste tenant —
nunca faz um `FLUSHALL`.

::: warning Fail-closed fora do contexto de tenant (apps multi-tenant)
Quando o `tenancyPlugin` está registado, uma operação de cache **sem scope de
tenant resolúvel** — um job em background ou uma tarefa de boot fora do contexto
do pedido — lança `MissingCacheScopeError` em vez de ler e escrever
silenciosamente num namespace partilhado por todos os tenants. Apps
single-tenant (sem plugin de tenancy) não são afetadas. Para correr um job para
um tenant específico, envolve-o em `runWithContext({ tenant })`; se a partilha
entre tenants for mesmo intencional, volta a optar com
`cachePlugin({ onMissingScope: 'global' })`.
:::

## get / put

```ts
await cache.put('config', { theme: 'dark' })   // sem TTL: fica até ser apagado
await cache.put('session', 'abc123', '30s')    // durações em string: 500ms 30s 5m 2h 7d
await cache.put('token', 'xyz', 60_000)        // …ou milissegundos

await cache.get('config')                      // { theme: 'dark' }
await cache.get('missing')                     // undefined
await cache.get('missing', 'default-value')    // 'default-value' (fallback em miss)
```

## remember

O cavalo de batalha — retorna o valor em cache ou computa, guarda em cache e retorna,
com proteção contra stampede por processo (misses concorrentes partilham uma
computação):

```ts
const plans = await cache.remember('plans', '1h', () => db.plans.findMany())
```

::: tip Dica
A deduplicação de stampede é **por processo** — usa um mapa em memória de promessas
em curso. Dois servidores podem ainda executar a factory ao mesmo tempo, mas dentro
de um processo ela corre exatamente uma vez, mesmo sob 100 misses concorrentes.
:::

### Stale-while-revalidate (SWR)

Passa `{ ttl, staleFor }` em vez de um TTL simples e o `remember` troca uma
quantidade limitada de desatualização por nunca bloquear uma leitura quente na
factory:

```ts
// Fresh for 1 minute; for the next 10 minutes a stale copy is served
// instantly while ONE background refresh runs.
const stats = await cache.remember(
  'dashboard-stats',
  { ttl: '1m', staleFor: '10m' },
  () => computeExpensiveStats(),
)
```

Uma leitura cai numa de três janelas:

| Janela | Idade da entrada | Comportamento |
| --- | --- | --- |
| Fresca | `< ttl` | Servida do cache, a factory nunca corre |
| Stale | `ttl` … `ttl + staleFor` | Servida **imediatamente**, uma revalidação em background atualiza a entrada |
| Expirada | `> ttl + staleFor` | Miss a sério — a leitura bloqueia na factory como num `remember` simples |

A revalidação em background reutiliza a mesma deduplicação por processo da
proteção contra stampede — no máximo um refresh por chave em curso, e um
refresh falhado continua a servir o valor stale (nunca aparece como unhandled
rejection). As entradas SWR são guardadas num pequeno envelope com as janelas
de frescura; o TTL ao nível do driver é `ttl + staleFor`, por isso uma entrada
expirada desaparece mesmo. Um valor cru escrito por `put()` ou por um
`remember` simples é servido como fresco — mudar uma chave para SWR não precisa
de migração.

## forget / flush

```ts
await cache.forget('plans')  // apaga uma chave; retorna true se existia
await cache.flush()          // apaga todas as chaves no scope deste tenant
```

## Tags

Agrupa chaves e invalida-as em conjunto:

```ts
await cache.tags('plans').put('pro', plan, '1h')
await cache.tags('plans').remember('enterprise', '1h', () => fetchPlan('enterprise'))
await cache.tags('plans').flush()   // remove todas as chaves com a tag 'plans'
```

## Drivers

`driver` é `'memory'`, `'redis'` (com `url`), ou uma instância `CacheDriver`
personalizada.

### Trocar memory → Redis

Produção é uma mudança de uma linha — aponta para um servidor Redis:

```ts
cachePlugin({ driver: 'redis', url: process.env.REDIS_URL }) // ex.: redis://localhost:6379
```

::: warning Aviso
Com `driver: 'redis'` a opção `url` é obrigatória, e o Redis serializa valores com
`JSON.stringify`/`JSON.parse` — guarda dados simples. Instâncias de classe, `Map` e
`Date` não sobrevivem à ida e volta (um `Date` volta como string).
:::

Para reutilizar uma conexão `ioredis` existente em vez de um URL, passa uma instância
`RedisCacheDriver`:

```ts
import { Redis } from 'ioredis'
import { cachePlugin, RedisCacheDriver } from '@basaltkit/cache'

const redis = new Redis(process.env.REDIS_URL!)
cachePlugin({ driver: new RedisCacheDriver(redis) })
// ou a partir de um URL: RedisCacheDriver.fromUrl(process.env.REDIS_URL!)
```

### Multinível (tiered)

`@basaltkit/cache-tiered` coloca um near cache in-process à frente de um far cache
partilhado (Redis) — as chaves quentes são servidas a partir da memória, cortando as
idas e voltas à rede, enquanto o Redis continua a ser a fonte da verdade entre
instâncias:

```ts
import { cachePlugin, MemoryCacheDriver, RedisCacheDriver } from '@basaltkit/cache'
import { TieredCacheDriver } from '@basaltkit/cache-tiered'

cachePlugin({
  driver: new TieredCacheDriver({
    layers: [new MemoryCacheDriver(), RedisCacheDriver.fromUrl(process.env.REDIS_URL!)],
    backfillTtlMs: 30_000, // quanto tempo o near cache mantém um valor lido do Redis (predefinição 60000)
  }),
})
```

Uma leitura verifica cada camada da mais rápida→mais lenta, faz curto-circuito no
primeiro hit e reabastece as camadas mais rápidas; escritas e invalidações espalham-se
por todas as camadas. Não tem lacunas de capacidade — o que quer que as camadas
suportem (tags, prefix flush), o driver tiered suporta por delegação.

::: tip A desatualização entre instâncias é limitada por `backfillTtlMs`
Não há um bus de invalidação entre instâncias — em vez disso, **cada escrita numa
camada near é limitada a `backfillTtlMs`** (tanto os backfills de leitura como os
`set()` diretos; a última camada, partilhada, mantém o TTL completo). Depois de
outra réplica atualizar ou apagar uma chave, nenhuma instância serve a sua cópia
local por mais tempo do que este limite. Mantém-no curto para dados que mudam
frequentemente; `backfillTtlMs: null` remove o limite por completo e só é seguro
com uma única réplica.
:::

## Escrever um driver

Implementa o contrato `CacheDriver` e passa a instância como `driver`:

```ts
import type { CacheDriver } from '@basaltkit/cache'

class MyCacheDriver implements CacheDriver {
  async get(key: string): Promise<unknown> { /* undefined em miss/expiração */ return undefined }
  async set(key: string, value: unknown, ttlMs?: number, tags?: string[]): Promise<void> { /* … */ }
  async delete(key: string): Promise<boolean> { /* … */ return false }
  async flushPrefix(prefix: string): Promise<void> { /* apaga chaves sob o prefixo */ }
  async flushTags(tags: string[]): Promise<void> { /* apaga chaves com qualquer tag */ }
  async disconnect(): Promise<void> { /* liberta conexões */ }
}
```

`TieredCacheDriver` é uma pequena implementação de referência — é composição pura
sobre outros drivers.


## Referência de opções

`cachePlugin(options)` — tudo é opcional:

| Opção | Tipo | Omissão | Propósito |
| --- | --- | --- | --- |
| `driver` | `'memory' \| 'redis' \| CacheDriver` | `'memory'` | Backend de armazenamento; passa uma instância para drivers tiered/personalizados |
| `url` | `string` | — | URL de conexão Redis — **obrigatório** com `driver: 'redis'` |
| `prefix` | `string` | `'basalt'` | Prefixo raiz de todas as chaves |
| `scope` | `(() => string \| undefined) \| null` | lê `ctx().tenant.id` → `tenant:<id>` | Segmento dinâmico do prefixo, resolvido em cada operação — o isolamento por tenant. `null` = cache **global** deliberado (sem scoping, sem fail-closed) |
| `onMissingScope` | `'global' \| 'error'` | vê abaixo | O que uma leitura/escrita faz quando a função de scope não resolve nada: `'global'` partilha um namespace, `'error'` lança `MissingCacheScopeError`. O `flush()` falha **sempre** fechado, independentemente |
| `now` | `() => number` | `Date.now` | Relógio injetável para as janelas de frescura SWR (testes) |

**Como a omissão de `onMissingScope` é escolhida.** Quando o
[`tenancyPlugin`](/pt/guide/tenancy) está registado, publica um marcador de
metadata `'tenancy:active'`; o `cachePlugin` lê-o e passa a omissão para
`'error'` — uma app multi-tenant falha fechada em vez de partilhar
silenciosamente um namespace entre tenants. Sem o marcador (app single-tenant)
a omissão continua `'global'`. Um `onMissingScope` explícito ou uma função
`scope` personalizada ganham sempre a esta deteção.

## Modos de falha e troubleshooting

| Erro | Código | Quando |
| --- | --- | --- |
| `MissingCacheScopeError` | `CACHE_SCOPE_MISSING` | Um cache scoped por tenant não resolveu tenant nenhum: qualquer leitura/escrita com `onMissingScope: 'error'` (a omissão sob `tenancyPlugin`), e **todos** os `flush()` com scope por resolver |

- **`CACHE_SCOPE_MISSING` num job em background, seed script ou tarefa de
  boot** — o código corre fora de um pedido, por isso nenhum tenant foi
  resolvido. Corre-o dentro de um contexto de tenant
  (`tenancy.run(tenantId, …)` / `runWithContext({ tenant })`), ou — só se os
  dados forem genuinamente partilhados — opta por sair com
  `onMissingScope: 'global'` ou um cache dedicado com `scope: null`.
- **O `flush()` lança mesmo com `onMissingScope: 'global'`** — intencional: sem
  scope resolvido, um flush limparia o namespace inteiro, ou seja, as chaves de
  **todos** os tenants de uma vez, por isso falha sempre fechado. Só
  `scope: null` (um cache deliberadamente global) faz flush sem tenant.
- **Valores voltam subtilmente errados no Redis** — ida e volta JSON: um `Date`
  volta como string, `Map`/instâncias de classe não sobrevivem. Guarda dados
  simples (vê o aviso em [Drivers](#drivers)).
- **A factory corre mais vezes do que o esperado numa frota** — a deduplicação
  de stampede e a revalidação SWR são **por processo**; duas réplicas podem
  computar em simultâneo. Dentro de um processo, cada chave computa exatamente
  uma vez.


## Pedidos condicionais (ETags)

Distinto do cache acima — uma otimização ao nível HTTP que evita reenviar uma
resposta inalterada. Marca uma rota com `meta: { etag: true }`: a framework faz o
hash da resposta `GET`/`HEAD` num `ETag` forte e, quando o cliente envia um
`If-None-Match` coincidente, responde `304 Not Modified` sem corpo. Adapter-agnostic
(fastify/express/hono), sem mudanças no handler.

```ts
route({
  method: 'GET',
  url: '/projects/:id',
  meta: { etag: true }, // ← ETag + tratamento de 304
  params: z.object({ id: z.string() }),
  async handler({ params }) { return db.projects.find(params.id) },
})
```

O cliente faz cache por `ETag` e revalida de forma barata — poupas serialização e
largura de banda em leituras inalteradas. O `computeEtag(body)` e o
`ifNoneMatchSatisfied(header, etag)` são exportados para fluxos personalizados.
