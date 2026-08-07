# @machize/cache

Camada de cache do Machize: guarda resultados de operações lentas (consultas à base de dados, chamadas a APIs externas, cálculos pesados) para os poder devolver instantaneamente nas próximas vezes. Precisas deste módulo quando a tua aplicação repete o mesmo trabalho vezes sem conta e queres torná-la mais rápida e barata.

## O que este módulo resolve

**Cache** é uma memória temporária: em vez de ires buscar a mesma informação à base de dados (ou a uma API externa) a cada pedido, guardas o resultado uma vez e reutiliza-lo durante um período de tempo. A esse período chama-se **TTL** (*time to live*, "tempo de vida") — passado esse tempo, o valor expira e é calculado de novo.

Este módulo dá-te uma classe `Cache` com uma API simples (`get`, `put`, `remember`, `forget`, `flush`, `tags`) que funciona sobre dois **drivers** (implementações de armazenamento intercambiáveis): **memória** (dentro do próprio processo Node.js — ideal para desenvolvimento e testes) e **Redis** (um servidor de cache externo, partilhado entre vários processos — ideal para produção).

Além disso resolve três problemas que normalmente dão trabalho:

1. **Isolamento por tenant** — numa aplicação SaaS multi-tenant (vários clientes/organizações na mesma aplicação), cada tenant vê apenas as suas próprias entradas de cache, automaticamente, sem precisares de compor chaves à mão.
2. **Proteção contra "stampede"** — se 100 pedidos chegarem ao mesmo tempo e o valor não estiver em cache, a função cara é executada **uma única vez**; os outros 99 pedidos esperam e recebem o mesmo resultado.
3. **Invalidação por tags** — podes agrupar entradas relacionadas (ex.: tudo o que diz respeito a "planos") e apagá-las todas de uma vez com uma linha.

## Instalação

```bash
pnpm add @machize/cache
```

O pacote depende de `@machize/core` (o núcleo do framework) e já inclui o cliente Redis (`ioredis`) — não precisas de instalar mais nada.

## Começar em 5 minutos

Passo a passo, do zero até teres cache a funcionar:

1. **Cria a aplicação e regista o plugin.** O `cachePlugin` regista uma instância de `Cache` no contentor de dependências da aplicação (o "contentor" é o sítio onde o Machize guarda os serviços partilhados).

2. **Obtém a cache através do token `CACHE`** e usa-a.

```ts
import { createApp } from '@machize/core'
import { CACHE, cachePlugin } from '@machize/cache'

// 1. Regista o plugin (driver 'memory' — não precisa de servidores externos)
const app = await createApp({
  plugins: [cachePlugin({ driver: 'memory' })],
}).boot()

// 2. Obtém a instância de Cache
const cache = app.container.get(CACHE)

// 3. Guarda um valor durante 5 minutos
await cache.put('saudacao', 'olá mundo', '5m')

// 4. Lê o valor (devolve undefined se não existir ou tiver expirado)
console.log(await cache.get('saudacao')) // 'olá mundo'

// 5. No fim da aplicação, desliga tudo (o driver é desconectado)
await app.shutdown()
```

Para produção com Redis basta mudar as opções do plugin:

```ts
import { cachePlugin } from '@machize/cache'

cachePlugin({ driver: 'redis', url: 'redis://localhost:6379' })
```

## Guia de utilização

### Ler e escrever valores (`get` / `put`)

```ts
import { Cache, MemoryCacheDriver } from '@machize/cache'

const cache = new Cache(new MemoryCacheDriver())

await cache.put('config', { tema: 'escuro' })        // sem TTL: fica até ser apagado
await cache.put('sessao', 'abc123', '30s')           // expira em 30 segundos
await cache.put('token', 'xyz', 60_000)              // TTL também aceita milissegundos

await cache.get('config')                            // { tema: 'escuro' }
await cache.get('inexistente')                       // undefined
await cache.get('inexistente', 'valor-por-omissao')  // 'valor-por-omissao' (fallback)
```

Os TTL aceitam um número em milissegundos **ou** uma string legível: `'500ms'`, `'30s'`, `'5m'`, `'2h'`, `'7d'`.

### `remember` — o padrão mais útil (cache-aside numa linha)

Em vez de escreveres "vê se está em cache; se não estiver, calcula e guarda", o `remember` faz tudo isso por ti — e com proteção contra stampede (chamadas simultâneas à mesma chave partilham **uma** execução da função):

```ts
import { Cache, MemoryCacheDriver } from '@machize/cache'

const cache = new Cache(new MemoryCacheDriver())

const planos = await cache.remember('planos', '1h', async () => {
  // Esta função só corre quando o valor NÃO está em cache.
  return buscarPlanosNaBaseDeDados()
})
```

### Apagar entradas (`forget` / `flush`)

```ts
await cache.forget('planos')  // apaga uma chave; devolve true se existia
await cache.flush()           // apaga TODAS as chaves deste prefixo/scope
                              // (nunca limpa o Redis inteiro — só as tuas chaves)
```

### Tags — invalidar grupos de entradas

Uma **tag** é uma etiqueta que associa várias entradas ao mesmo grupo. Quando os dados de origem mudam, invalidas o grupo inteiro:

```ts
import { Cache, MemoryCacheDriver } from '@machize/cache'

const cache = new Cache(new MemoryCacheDriver())

await cache.tags('planos').put('plano:gratis', { preco: 0 })
await cache.tags('planos').put('plano:pro', { preco: 29 })
await cache.put('outra-coisa', 'fica')

// Também há remember com tags:
await cache.tags('planos').remember('plano:enterprise', '1h', () => buscarPlano('enterprise'))

// Alguém alterou os planos? Invalida o grupo todo:
await cache.tags('planos').flush()

await cache.get('plano:gratis')  // undefined
await cache.get('outra-coisa')   // 'fica' (não tinha a tag)
```

### Isolamento automático por tenant

Se a tua aplicação usa o sistema de tenancy do Machize, cada operação de cache lê o tenant do **contexto do pedido** (`ctx().tenant.id`) e prefixa as chaves com `tenant:<id>`. Cada tenant tem assim a sua "gaveta" própria — sem código extra:

```ts
import { runWithContext } from '@machize/core'
import { Cache, MemoryCacheDriver } from '@machize/cache'

const cache = new Cache(new MemoryCacheDriver())

await runWithContext({ tenant: { id: 'acme' } }, () => cache.put('config', 'da-acme'))
await runWithContext({ tenant: { id: 'globex' } }, () => cache.put('config', 'da-globex'))
await cache.put('config', 'central') // fora de qualquer tenant

await runWithContext({ tenant: { id: 'acme' } }, () => cache.get('config')) // 'da-acme'
await cache.get('config')                                                   // 'central'

// flush() de um tenant não toca nos outros nem no espaço central
await runWithContext({ tenant: { id: 'acme' } }, () => cache.flush())
```

Nos pedidos HTTP normais não precisas de chamar `runWithContext` — o framework fá-lo por ti. Para desativar o isolamento, passa `scope: null` nas opções.

### Usar um driver Redis já existente (Avançado)

```ts
import { Redis } from 'ioredis'
import { Cache, RedisCacheDriver } from '@machize/cache'

// A partir de um URL:
const cacheA = new Cache(RedisCacheDriver.fromUrl('redis://localhost:6379'))

// Ou reutilizando uma ligação ioredis tua:
const redis = new Redis('redis://localhost:6379')
const cacheB = new Cache(new RedisCacheDriver(redis))
```

## Referência da API

### `class Cache`

`new Cache(driver: CacheDriver, options?: CacheOptions)`

| Método | Assinatura | Descrição |
|---|---|---|
| `get` | `get<T>(key: string): Promise<T \| undefined>` / `get<T>(key: string, fallback: T): Promise<T>` | Lê um valor; devolve `undefined` (ou o `fallback`) em caso de falta/expiração. |
| `put` | `put(key: string, value: unknown, ttl?: DurationInput): Promise<void>` | Guarda um valor, com TTL opcional. |
| `remember` | `remember<T>(key: string, ttl: DurationInput, factory: () => Promise<T> \| T): Promise<T>` | Devolve o valor em cache ou executa a `factory` (uma só vez, mesmo com chamadas concorrentes) e guarda o resultado. |
| `forget` | `forget(key: string): Promise<boolean>` | Apaga uma chave; `true` se existia. |
| `flush` | `flush(): Promise<void>` | Apaga todas as chaves do prefixo/scope atual. |
| `tags` | `tags(...tags: string[])` | Devolve um objeto com `put`, `remember` e `flush` limitados às tags indicadas. |

#### `CacheOptions`

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `prefix` | `string` | Não | `'mach'` | Prefixo raiz de todas as chaves. |
| `scope` | `(() => string \| undefined) \| null` | Não | lê `ctx().tenant.id` → `tenant:<id>` | Segmento dinâmico do prefixo, resolvido em cada operação. `null` desativa o isolamento por tenant. |

### `cachePlugin(options?: CachePluginOptions)`

Regista a `Cache` no contentor sob o token `CACHE` e desconecta o driver no `shutdown` da aplicação.

#### `CachePluginOptions` (estende `CacheOptions`)

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `driver` | `'memory' \| 'redis'` | Não | `'memory'` | Qual o driver a usar. |
| `url` | `string` | Sim, com `driver: 'redis'` | — | URL de ligação ao Redis (ex.: `redis://localhost:6379`). |
| `prefix`, `scope` | — | Não | ver `CacheOptions` | Herdadas de `CacheOptions`. |

### `CACHE`

Token de injeção de dependências: `app.container.get(CACHE)` devolve a instância de `Cache`.

### `interface CacheDriver` (Avançado)

Contrato que qualquer driver tem de cumprir — implementa-o para criar o teu próprio armazenamento:

| Método | Assinatura | Descrição |
|---|---|---|
| `get` | `get(key: string): Promise<unknown>` | `undefined` em falta/expirado. |
| `set` | `set(key: string, value: unknown, ttlMs?: number, tags?: string[]): Promise<void>` | Guarda o valor (TTL em milissegundos). |
| `delete` | `delete(key: string): Promise<boolean>` | Apaga uma chave. |
| `flushPrefix` | `flushPrefix(prefix: string): Promise<void>` | Apaga todas as chaves que começam pelo prefixo. |
| `flushTags` | `flushTags(tags: string[]): Promise<void>` | Apaga todas as chaves associadas a qualquer uma das tags. |
| `disconnect` | `disconnect(): Promise<void>` | Liberta recursos/ligações. |

### `class MemoryCacheDriver` (Avançado)

`new MemoryCacheDriver()` — guarda tudo num `Map` dentro do processo. Sem opções. Perfeito para desenvolvimento e testes; os dados perdem-se quando o processo termina e não são partilhados entre processos.

### `class RedisCacheDriver` (Avançado)

| Membro | Assinatura | Descrição |
|---|---|---|
| construtor | `new RedisCacheDriver(redis: Redis)` | Recebe uma instância `ioredis` já criada. |
| `fromUrl` | `static fromUrl(url: string): RedisCacheDriver` | Cria a ligação a partir de um URL. |

Os valores são serializados com `JSON.stringify`/`JSON.parse` — só podes guardar valores serializáveis em JSON (nada de funções, `Date` vira string, etc.).

## Erros comuns e soluções (FAQ)

**`get` devolve sempre `undefined` depois de eu ter feito `put`.**
Provavelmente o `put` e o `get` correram em contextos de tenant diferentes (ou um dentro e outro fora de um tenant) — as chaves ficam em prefixos distintos. Confirma o contexto, ou passa `scope: null` se não quiseres isolamento.

**Erro `DURATION_INVALID` ao passar um TTL.**
O TTL tem de ser um número (milissegundos) ou uma string no formato `'500ms'`, `'30s'`, `'5m'`, `'2h'`, `'7d'`. `'5 minutos'` ou `'1w'` não são aceites.

**Guardei um objeto no Redis e veio de volta "diferente".**
O driver Redis serializa em JSON. Instâncias de classes, `Date`, `Map`, funções — tudo isso se perde ou vira representação JSON. Guarda dados simples (objetos, arrays, strings, números, booleanos).

**A proteção contra stampede não funciona entre servidores.**
É por desenho: a deduplicação do `remember` é **por processo** (usa um mapa em memória de promessas em curso). Dois servidores distintos podem executar a factory ao mesmo tempo — mas dentro de cada servidor executa uma só vez.

**`flush()` apagou menos do que eu esperava.**
`flush()` apaga apenas as chaves sob o prefixo + scope atuais (é essa a garantia de segurança: nunca faz `FLUSHALL` no Redis). Para limpar as chaves de um tenant, chama `flush()` dentro do contexto desse tenant.

**Configurei `driver: 'redis'` e a aplicação falha ao arrancar/usar a cache.**
Com `driver: 'redis'`, a opção `url` é obrigatória. Verifica também que o servidor Redis está acessível nesse URL.

## Como se liga aos outros módulos

- **`@machize/core`** — fornece o `createApp`, o contentor de dependências, o contexto de pedido (`ctx`/`runWithContext`) de onde vem o isolamento por tenant, e o `parseDuration` dos TTL.
- **`@machize/tenancy`** — quando o plugin de tenancy identifica o tenant do pedido e o coloca no contexto, a cache passa automaticamente a isolar as chaves por tenant.
- **`@machize/prisma`** — combina bem com `cache.remember(...)` para guardar resultados de consultas caras à base de dados.
- **`@machize/flags`, `@machize/permissions`, etc.** — qualquer módulo pode obter a cache via `container.get(CACHE)` para acelerar as suas próprias operações.
