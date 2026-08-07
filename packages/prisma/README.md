# @machize/prisma

Integração do Machize com o Prisma: liga a tua aplicação à base de dados de forma multi-tenant — cada cliente (tenant) só vê os seus próprios dados, automaticamente. Precisas deste módulo quando a tua aplicação SaaS usa Prisma e serve vários clientes com dados isolados entre si.

## O que este módulo resolve

O **Prisma** é um **ORM** (*Object-Relational Mapper*): uma biblioteca que te deixa falar com a base de dados escrevendo código TypeScript (`db.project.findMany()`) em vez de SQL à mão. Numa aplicação **multi-tenant** (vários clientes/organizações — os **tenants** — na mesma aplicação) surge o problema central: como garantir que o cliente "acme" nunca vê os dados do cliente "globex"?

Este módulo suporta as três estratégias clássicas de isolamento e trata do trabalho chato de cada uma:

1. **Base de dados partilhada** — todos os tenants na mesma base de dados, cada linha com uma coluna `tenantId`. A extensão `tenancyExtension()` intercepta **todas** as consultas e injeta o filtro do tenant atual: é impossível o código da aplicação esquecer-se do `where: { tenantId }` ou tentar fugir dele.
2. **Schema por tenant** (PostgreSQL) — uma base de dados, mas cada tenant tem o seu próprio *schema* (um "compartimento" com as suas próprias tabelas). O módulo deriva nomes de schema seguros, constrói URLs de ligação com o schema certo e cria os schemas quando preciso.
3. **Base de dados por tenant** — isolamento máximo: cada tenant tem a sua própria base de dados. O módulo gere um **pool LRU** de clientes Prisma (mantém abertos só os N mais recentes, fecha os restantes) para as ligações não explodirem.

Em qualquer modo, o `prismaPlugin` coloca o cliente certo no contexto de cada pedido — o código da aplicação escreve apenas `db<PrismaClient>().project.findMany()` sem saber (nem querer saber) qual a estratégia por trás. Há ainda ferramentas para **migrações** (aplicar alterações de estrutura da base de dados) tenant a tenant, incluindo um comando de CLI pronto a usar.

## Instalação

```bash
pnpm add @machize/prisma
```

Depende de `@machize/core` e `@machize/cli`. O Prisma em si é uma *peer dependency* opcional — instala-o no teu projeto se ainda não o tiveres:

```bash
pnpm add @prisma/client   # requer versão >= 5.0.0
pnpm add -D prisma
```

## Começar em 5 minutos

O caminho mais comum: base de dados partilhada com coluna `tenantId`.

1. **Adiciona a coluna `tenantId`** aos modelos do teu `schema.prisma`:

```prisma
model Project {
  id       String @id @default(cuid())
  name     String
  tenantId String   // a coluna que isola os tenants

  @@index([tenantId])
}
```

2. **Cria o cliente Prisma com a extensão de tenancy** e regista o plugin:

```ts
import { PrismaClient } from '@prisma/client'
import { createApp } from '@machize/core'
import { prismaPlugin, tenancyExtension } from '@machize/prisma'

// O cliente partilhado: cada consulta é filtrada pelo tenant do contexto atual
const prisma = new PrismaClient().$extends(tenancyExtension())

const app = await createApp({
  plugins: [
    prismaPlugin({ client: prisma }),
    // ...os teus outros plugins (http, tenancy, etc.)
  ],
}).boot()
```

3. **Usa `db()` em qualquer ponto do código de um pedido** — o cliente já vem do contexto:

```ts
import { db } from '@machize/prisma'
import type { PrismaClient } from '@prisma/client'

// Dentro de um handler HTTP (o tenant já foi identificado pelo framework):
const projetos = await db<PrismaClient>().project.findMany()
// → SELECT ... WHERE tenantId = '<tenant do pedido>' — sem escreveres o filtro
```

É tudo: as leituras são filtradas pelo tenant, as criações são carimbadas com o `tenantId` certo, e nem por engano um pedido toca em dados de outro tenant.

## Guia de utilização

### Modo 1 — Base de dados partilhada (`tenancyExtension`)

A extensão cobre todas as operações de todos os modelos:

- **Leituras e escritas com `where`** (`findMany`, `findFirst`, `findUnique`, `count`, `aggregate`, `groupBy`, `update`, `updateMany`, `delete`, `deleteMany`): o filtro `tenantId` é **forçado** — mesmo que o código passe `where: { tenantId: 'outro' }`, o filtro do tenant atual ganha.
- **Criações** (`create`, `createMany`, `createManyAndReturn`): o `tenantId` é carimbado nos dados.
- **`upsert`**: o `where` é filtrado e o ramo `create` é carimbado; o ramo `update` fica intacto.

```ts
import { PrismaClient } from '@prisma/client'
import { tenancyExtension } from '@machize/prisma'

const prisma = new PrismaClient().$extends(
  tenancyExtension({
    tenantField: 'tenantId',      // nome da coluna (default: 'tenantId')
    onMissingTenant: 'bypass',    // sem tenant no contexto: 'bypass' (default) corre sem filtro
                                  // — útil para contexto administrativo/central;
                                  // 'error' lança MissingTenantError — isolamento estrito
  }),
)
```

Nota sobre `findUnique`/`update`/`delete`: desde o Prisma 5, o `where` único aceita campos extra como filtros adicionais — o módulo injeta aí o `tenantId`, pelo que uma linha de outro tenant simplesmente "não é encontrada".

### Modo 2 — Schema por tenant (PostgreSQL)

Cada tenant tem um schema próprio (`tenant_acme`, `tenant_globex`, …) na mesma base de dados. O cliente de cada tenant liga-se com `?schema=<nome>` no URL — é o Prisma que define o `search_path` na ligação (a forma fiável de fazer isto):

```ts
import { PrismaClient } from '@prisma/client'
import { createApp } from '@machize/core'
import { prismaPlugin } from '@machize/prisma'

const app = await createApp({
  plugins: [
    prismaPlugin({
      schemaPerTenant: {
        url: process.env.DATABASE_URL!, // URL base; o parâmetro ?schema= é posto por tenant
        createClient: (url) => new PrismaClient({ datasourceUrl: url }),
        prefix: 'tenant_',              // default: 'tenant_'
      },
      destroy: (client) => client.$disconnect(), // fecha clientes quando saem do pool
      max: 10,                                    // máximo de clientes abertos em simultâneo
    }),
  ],
}).boot()
```

O nome do schema é derivado com `tenantSchema(tenantId)`: minúsculas, só `[a-z0-9_]`, máximo 63 carateres — ids inválidos lançam `InvalidTenantSchemaError`. Para criar o schema de um tenant novo:

```ts
import { PrismaClient } from '@prisma/client'
import { provisionTenantSchema, tenantSchema } from '@machize/prisma'

const admin = new PrismaClient() // ligação administrativa
const schema = tenantSchema('acme')          // 'tenant_acme'
await provisionTenantSchema(admin, schema)   // CREATE SCHEMA IF NOT EXISTS "tenant_acme"
```

### Modo 3 — Base de dados por tenant (`forTenant`)

Isolamento máximo: dás uma função que cria o cliente para um id de tenant, e o módulo gere o pool:

```ts
import { PrismaClient } from '@prisma/client'
import { createApp } from '@machize/core'
import { prismaPlugin } from '@machize/prisma'

const app = await createApp({
  plugins: [
    prismaPlugin({
      forTenant: (tenantId) =>
        new PrismaClient({ datasourceUrl: urlDaBaseDeDados(tenantId) }),
      destroy: (client) => client.$disconnect(),
      max: 10, // só os 10 tenants mais recentemente ativos ficam com cliente aberto
    }),
  ],
}).boot()
```

O pool é **LRU** (*least recently used*): quando o limite é excedido, o cliente do tenant há mais tempo sem uso é fechado (via `destroy`). Tenants ativos reutilizam sempre o mesmo cliente.

Podes combinar `client` (para o contexto central, sem tenant) com `forTenant`/`schemaPerTenant` (para pedidos com tenant) no mesmo plugin.

### `db()` — o cliente do contexto atual

```ts
import { db } from '@machize/prisma'
import type { PrismaClient } from '@prisma/client'

const projetos = await db<PrismaClient>().project.findMany()
```

Funciona dentro de um pedido HTTP ou de `tenancy.run()`/workers (o plugin escuta o hook `tenancy:switched`). Fora de qualquer contexto lança `DbUnavailableError`. O genérico `<PrismaClient>` é só para o TypeScript — passa o tipo do teu cliente (incluindo o tipo estendido, se usares `$extends`).

### Migrações multi-tenant (`migrateTenants`)

Uma **migração** aplica alterações de estrutura (novas tabelas, colunas…) à base de dados. Nos modos 2 e 3 tens de a correr para **cada** tenant. O `migrateTenants` orquestra isso com concorrência limitada, e um tenant que falhe não impede os restantes:

```ts
import { PrismaClient } from '@prisma/client'
import { migrateTenants } from '@machize/prisma'

const admin = new PrismaClient()

const resultados = await migrateTenants({
  tenants: ['acme', 'globex', 'initech'],
  target: {
    mode: 'schema',                  // ou { mode: 'database', urlFor: (id) => url }
    url: process.env.DATABASE_URL!,
    provision: admin,                // cria o schema antes de migrar, se não existir
  },
  concurrency: 5,                    // default: 5 tenants em paralelo
  onResult: (r) => console.log(r.tenantId, r.ok ? 'ok' : `FALHOU: ${r.error}`),
})

const falhados = resultados.filter((r) => !r.ok)
```

Por omissão cada tenant é migrado com `prismaMigrator()`, que executa `npx prisma migrate deploy` com o URL do tenant como `DATABASE_URL` (requer o CLI do Prisma instalado).

### Comando de CLI `tenant:migrate`

Versão pronta para a linha de comandos — regista-o com o `commandsPlugin` de `@machize/cli`:

```ts
import { createApp } from '@machize/core'
import { commandsPlugin } from '@machize/cli'
import { tenantMigrateCommand } from '@machize/prisma'

const app = createApp({
  plugins: [
    commandsPlugin([
      tenantMigrateCommand({
        tenants: async () => listarIdsDeTenants(), // vai buscar os ids onde quiseres
        target: { mode: 'schema', url: process.env.DATABASE_URL! },
      }),
    ]),
  ],
})
```

Correr `mach tenant:migrate` imprime um relatório por tenant (`ok`/`FAIL`) e termina com código de saída diferente de zero se algum tenant falhou — ideal para pipelines de CI/CD.

## Referência da API

### `prismaPlugin(options: PrismaPluginOptions<TClient>)`

Regista o(s) cliente(s) no contentor (`DB`, `DB_POOL`), anexa o cliente ao contexto de cada pedido HTTP e de cada `tenancy.run()`, e no `shutdown` fecha o pool e chama `$disconnect()` no cliente partilhado.

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `client` | `TClient` | Não* | — | Modo partilhado: um cliente para todos (tipicamente com `$extends(tenancyExtension())`). Também usado como cliente do contexto sem tenant nos outros modos. |
| `forTenant` | `(tenantId: string) => TClient \| Promise<TClient>` | Não* | — | Modo base-de-dados-por-tenant: fábrica de clientes. |
| `schemaPerTenant` | `{ url: string; createClient: (url: string) => TClient \| Promise<TClient>; prefix?: string }` | Não* | `prefix: 'tenant_'` | Modo schema-por-tenant: URL base + fábrica a partir do URL com `?schema=`. |
| `destroy` | `(client: TClient, tenantId: string) => void \| Promise<void>` | Não | — | Chamado quando um cliente sai do pool (ex.: `client.$disconnect()`). |
| `max` | `number` | Não | `10` | Máximo de clientes por-tenant abertos em simultâneo. |

\* Usa pelo menos uma das três: `client`, `forTenant` ou `schemaPerTenant` (`forTenant` tem prioridade sobre `schemaPerTenant`).

### `db<T>()`

`db<T = unknown>(): T` — devolve o cliente de base de dados do contexto atual. Lança `DbUnavailableError` (código `DB_UNAVAILABLE`) fora de um pedido/`tenancy.run()` com o plugin configurado.

### `tenancyExtension(options?: TenancyExtensionOptions)`

Extensão de cliente Prisma (`prisma.$extends(...)`) que limita todas as consultas ao tenant do contexto.

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `tenantField` | `string` | Não | `'tenantId'` | Nome da coluna com o id do tenant. |
| `getTenantId` | `() => string \| undefined` | Não | lê `ctx().tenant.id` | Como obter o tenant atual. |
| `onMissingTenant` | `'bypass' \| 'error'` | Não | `'bypass'` | Sem tenant no contexto: `'bypass'` corre sem filtro (contexto central/admin); `'error'` lança `MissingTenantError`. |

### `applyTenantScope(operation, args, tenantId, field)` (Avançado)

`applyTenantScope(operation: string, args: Record<string, unknown> | undefined, tenantId: string, field: string): Record<string, unknown>` — a transformação pura usada pela extensão; útil para testes ou integrações próprias.

### `class TenantClientPool<TClient>` (Avançado)

`new TenantClientPool(options: TenantClientPoolOptions<TClient>)` — pool LRU de clientes por tenant.

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `create` | `(tenantId: string) => TClient \| Promise<TClient>` | Sim | — | Cria o cliente de um tenant. |
| `destroy` | `(client: TClient, tenantId: string) => void \| Promise<void>` | Não | — | Chamado na eviction. |
| `max` | `number` | Não | `10` | Máximo de clientes abertos (mínimo 1). |

| Membro | Assinatura | Descrição |
|---|---|---|
| `get` | `get(tenantId: string): Promise<TClient>` | Devolve/cria o cliente do tenant; promove-o a mais-recente; despeja o mais antigo acima de `max`. |
| `has` | `has(tenantId: string): boolean` | O tenant tem cliente no pool? |
| `size` | `get size(): number` | Número de clientes abertos. |
| `destroyAll` | `destroyAll(): Promise<void>` | Fecha todos os clientes. |

### Utilitários de schema

| Export | Assinatura | Descrição |
|---|---|---|
| `tenantSchema` | `tenantSchema(tenantId: string, options?: { prefix?: string }): string` | Deriva um identificador de schema PostgreSQL seguro (`prefix` default `'tenant_'`; minúsculas, `[a-z0-9_]`, máx. 63 carateres). Lança `InvalidTenantSchemaError`. |
| `schemaUrl` | `schemaUrl(baseUrl: string, schema: string): string` | Devolve o URL de ligação com o parâmetro `?schema=` definido. |
| `provisionTenantSchema` | `provisionTenantSchema(client: SchemaProvisioner, schema: string): Promise<void>` | Executa `CREATE SCHEMA IF NOT EXISTS` (nome validado antes de interpolar). |
| `SchemaProvisioner` | `{ $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> }` | Interface satisfeita por um `PrismaClient`. |

### `migrateTenants(options: MigrateTenantsOptions)`

Devolve `Promise<TenantMigrationResult[]>` — um resultado por tenant, na mesma ordem.

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `tenants` | `string[]` | Sim | — | Ids dos tenants a migrar. |
| `target` | `MigrateTarget` | Sim | — | Como derivar o alvo de cada tenant (ver abaixo). |
| `migrate` | `MigrateFn` | Não | `prismaMigrator()` | Executa a migração de um tenant. |
| `concurrency` | `number` | Não | `5` | Máximo de tenants migrados em paralelo. |
| `onResult` | `(result: TenantMigrationResult) => void` | Não | — | Chamado à medida que cada tenant termina. |

`MigrateTarget` é uma de duas formas:

- `{ mode: 'schema', url: string, prefix?: string, provision?: SchemaProvisioner }` — schema por tenant; com `provision`, cria o schema antes de migrar.
- `{ mode: 'database', urlFor: (tenantId: string) => string }` — base de dados por tenant.

`TenantMigrationResult`: `{ tenantId: string; url: string; schema?: string; ok: boolean; error?: string }`.

`MigrateFn`: `(info: { tenantId: string; url: string; schema?: string }) => Promise<void>`.

### `prismaMigrator(options?: PrismaMigratorOptions)`

Migrador por omissão: executa `npx prisma migrate deploy` num processo filho, com o URL do tenant como `DATABASE_URL`.

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `schemaPath` | `string` | Não | localização por omissão do Prisma | Caminho para o `schema.prisma` (`--schema`). |
| `env` | `Record<string, string>` | Não | — | Variáveis de ambiente extra para o processo filho. |

### `tenantMigrateCommand(config: TenantMigrateCommandConfig)`

Devolve um `CommandDefinition` (`@machize/cli`) chamado `tenant:migrate`.

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `tenants` | `() => string[] \| Promise<string[]>` | Sim | — | Resolve os ids a migrar. |
| `target` | `MigrateTarget` | Sim | — | Alvo das migrações. |
| `migrate` | `MigrateFn` | Não | `prismaMigrator()` | Migrador alternativo. |
| `concurrency` | `number` | Não | `5` | Paralelismo. |

### Tokens e erros

| Export | Descrição |
|---|---|
| `DB` | Token do cliente partilhado no contentor. (Avançado) |
| `DB_POOL` | Token do `TenantClientPool` no contentor. (Avançado) |
| `DbUnavailableError` | Código `DB_UNAVAILABLE` — `db()` fora de contexto. |
| `MissingTenantError` | Código `PRISMA_TENANT_MISSING` — consulta sem tenant com `onMissingTenant: 'error'`. |
| `InvalidTenantSchemaError` | Código `PRISMA_INVALID_SCHEMA` — id de tenant sem identificador de schema válido. |

## Erros comuns e soluções (FAQ)

**`DB_UNAVAILABLE: No database client in the current context`.**
Chamaste `db()` fora de um pedido HTTP ou de `tenancy.run()`, ou o `prismaPlugin` não está registado. Em scripts/jobs, corre o código dentro de `tenancy.run()` (ou usa diretamente o teu `PrismaClient`).

**`PRISMA_TENANT_MISSING` numa consulta.**
Configuraste `onMissingTenant: 'error'` e a consulta correu sem tenant no contexto. Ou identificas o tenant antes (plugin de tenancy / `tenancy.run()`), ou usas `'bypass'` para permitir consultas centrais sem filtro.

**Passei `where: { tenantId: 'outro' }` e "não funcionou".**
É mesmo assim: a extensão força o filtro do tenant atual por cima do que o código passar — é essa a garantia de isolamento. Para operações entre tenants usa um cliente sem a extensão (contexto administrativo).

**As criações falham por falta de `tenantId` / ou os dados "desaparecem".**
No modo partilhado, todos os modelos consultados via extensão precisam da coluna `tenantId` (ou do nome que definires em `tenantField`). Linhas criadas fora do contexto do tenant certo ficam invisíveis nas consultas desse tenant.

**Schema-por-tenant: mudar o schema por pedido na mesma ligação não funciona?**
Correto — alternar o `search_path` por pedido num pool partilhado não é fiável com o Prisma. Por isso este módulo cria **um cliente por tenant** com `?schema=` no URL; o `search_path` fica definido ao ligar.

**`PRISMA_INVALID_SCHEMA` para um id de tenant.**
O id não gera um identificador PostgreSQL válido (ex.: só símbolos, ou nome acima de 63 carateres com o prefixo). Usa ids simples (letras minúsculas, números, `_`) ou um `prefix` mais curto.

**Demasiadas ligações à base de dados no modo por-tenant.**
Ajusta `max` no `prismaPlugin` (default 10) e garante que passas `destroy: (client) => client.$disconnect()` — sem isso, os clientes despejados do pool ficam com a ligação aberta.

**`prismaMigrator` falha com "command not found" ou não encontra o schema.**
Precisa do CLI do Prisma disponível (`pnpm add -D prisma`) e, se o `schema.prisma` não estiver no sítio habitual, passa `schemaPath`.

## Como se liga aos outros módulos

- **`@machize/core`** — fornece o `createApp`, o contentor, os hooks e o contexto de pedido; este módulo acrescenta `ctx().db` ao `RequestContext`.
- **`@machize/tenancy`** — é quem identifica o tenant de cada pedido e emite `tenancy:switched`; sem tenant no contexto, a extensão faz *bypass* (ou lança erro, conforme configurado) e o plugin usa o cliente central.
- **`@machize/cli`** — o `tenantMigrateCommand` é um comando `defineCommand` registado via `commandsPlugin` e executado com o binário `mach`.
- **`@machize/http` / `@machize/express` / `@machize/fastify` / `@machize/hono`** — o plugin regista um *enricher* HTTP que anexa o cliente ao contexto de cada pedido, para o `db()` funcionar nos handlers.
- **`@machize/cache`** — combina `db()` com `cache.remember(...)` para acelerar consultas caras, com isolamento por tenant coerente nos dois módulos.
