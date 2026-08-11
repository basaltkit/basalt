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

::: tip Invalidação entre instâncias
Uma invalidação local só limpa o near cache **deste** nó. Para remover o near cache
em todo o lado, dispara a invalidação a partir de um evento partilhado, ou mantém o
`backfillTtlMs` curto para limitar a desatualização.
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
