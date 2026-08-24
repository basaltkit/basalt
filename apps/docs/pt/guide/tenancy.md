# Multi-tenancy

`@basaltkit/tenancy` torna cada pedido ciente do tenant. Uma vez resolvido o tenant,
ele vive no contexto — e a cache, o storage, a queue, o logger e o teu client Prisma
passam todos a ter âmbito nele automaticamente.

## Resolvers

Um **resolver** mapeia um pedido recebido para uma referência de tenant. Passas uma lista;
correm por ordem e vence o primeiro cuja referência carrega um tenant **existente** a
partir da source. Uma referência a um id desconhecido cai para o resolver seguinte, para
que os possas empilhar em segurança.

```ts
import {
  tenancyPlugin,
  MemoryTenantSource,
  headerResolver,
  subdomainResolver,
} from '@basaltkit/tenancy'

tenancyPlugin({
  source: new MemoryTenantSource()
    .add({ id: 'acme', name: 'Acme Inc' })
    .add({ id: 'globex', name: 'Globex' }),
  resolvers: [
    headerResolver(),                          // x-tenant-id: acme
    subdomainResolver({ base: 'basalt.app' }), // acme.basalt.app
  ],
})
```

### Os quatro resolvers incorporados

```ts
import {
  subdomainResolver,
  domainResolver,
  headerResolver,
  routeResolver,
} from '@basaltkit/tenancy'

// acme.basalt.app → { id: 'acme' }. Ignora 'www', o domínio base nu,
// subdomínios aninhados (a.b.basalt.app), e a porta.
subdomainResolver({ base: 'basalt.app' })

// app.acme.com → { domain: 'app.acme.com' }, procurado via source.findByDomain.
// Requer que a source implemente findByDomain (ver abaixo).
domainResolver()

// Lê um header HTTP (padrão 'x-tenant-id') → { id: <value> }.
headerResolver()                 // x-tenant-id: acme
headerResolver({ header: 'x-org' })

// Lê um parâmetro de rota (padrão 'tenant') → { id: params.tenant }.
// Corresponde a rotas como /t/:tenant/...
routeResolver()                  // /t/acme/...
routeResolver({ param: 'org' })  // /o/:org/...
```

::: warning Aviso
Não confies num header fornecido pelo browser em produção. `headerResolver` é ideal para
desenvolvimento e tráfego interno, mas um utilizador pode enviar
`x-tenant-id: another-customer` à mão. Em produção prefere
`subdomainResolver` / `domainResolver` (o DNS está sob o teu controlo), e verifica que
o utilizador autenticado pertence ao tenant resolvido.
:::

### Resolvers personalizados

Um resolver é apenas uma função `(request) => TenantRef | null` (async permitido),
onde `request` é a forma neutra `{ headers?, params?, url? }` e um
`TenantRef` é `{ id }` ou `{ domain }`. Escreve o teu quando os incorporados não
servirem — p. ex. derivar o tenant de uma claim de JWT já presente no pedido:

```ts
import type { TenantResolver } from '@basaltkit/tenancy'

const claimResolver: TenantResolver = (request) => {
  const org = request.headers?.['x-org-claim']
  return typeof org === 'string' ? { id: org } : null
}

tenancyPlugin({ source, resolvers: [claimResolver, subdomainResolver({ base: 'basalt.app' })] })
```

`MemoryTenantSource` é para desenvolvimento e testes. Em produção usa um `TenantSource`
durável (abaixo) — ou implementa o contrato sobre a tua própria base de dados.

## O contrato TenantSource

Um tenant é um **registo aberto** — `{ id, ...anything }` — para que possas anexar
quaisquer campos por tenant (`name`, `plan`, `domains`, definições…) e eles fazem
round-trip inalterados. Um `TenantSource` é onde esses registos vivem; a interface
completa é pequena:

```ts
import type { TenantSource } from '@basaltkit/tenancy'

const source: TenantSource = {
  async find(id) { /* SELECT … WHERE id = ? */ return null }, // obrigatório
  async findByDomain(domain) { return null }, // opcional — necessário para domainResolver()
  async list() { return [] },                 // opcional — necessário para tenancy.forEach()
}
```

Raramente escreves isto à mão — usa `MemoryTenantSource` em dev, ou uma source durável
em produção (ambas mostradas abaixo). Só implementa a interface tu mesmo quando os
tenants já vivem numa tabela que possuis.

## Domínios custom (verificados)

O `domainResolver()` mapeia `app.acme.com → { domain }` e o `findByDomain` carrega o
tenant. Mas não podes deixar um tenant *reclamar* um domínio que não é dele. O
`CustomDomains` trata disso: regista um domínio (não verificado), prova a posse com
um registo DNS TXT, e só os domínios **verificados** resolvem.

```ts
import { CustomDomains } from '@basaltkit/tenancy'

const domains = new CustomDomains({ store }) // store default: em memória

// 1. O tenant adiciona o domínio → mostras-lhe o registo DNS a publicar
const { dns } = await domains.add('acme', 'app.acme.com')
// dns → { type: 'TXT', host: '_basalt-verify.app.acme.com', value: 'basalt-domain-verify=…' }

// 2. Depois de o adicionar, verifica — um lookup DNS real confirma o token.
//    verify/instructions/remove são scoped ao tenant dono.
if (await domains.verify('acme', 'app.acme.com')) { /* ativo */ }

// 3. Liga os domínios verificados à tua source com o helper — um Host forjado
//    ou não verificado nunca resolve para um tenant.
const source: TenantSource = {
  async find(id) { /* … */ },
  findByDomain: findByVerifiedDomain(domains, (id) => /* carrega o tenant */ this.find(id)),
}
```

O `verify()` faz um lookup `TXT` real via `node:dns` (injetável nos testes). Fornece um
`DomainStore` durável (com a forma de `MemoryDomainStore`) para persistir os domínios.
O provisionamento do certificado TLS é infraestrutura — emite o certificado na tua
plataforma (Cloudflare, Caddy, ACME) assim que o `verify()` devolver `true`.

## Criar tenants

A forma de criares um tenant depende do backend.

### Em dev — `MemoryTenantSource`

Semeia-os inline; as chamadas `add()` encadeiam. Perdidos ao reiniciar, portanto só
dev/testes:

```ts
const tenants = new MemoryTenantSource()
  .add({ id: 'acme', name: 'Acme Inc' })
  .add({ id: 'globex', name: 'Globex', domains: ['app.globex.com'] })

tenancyPlugin({ source: tenants, resolvers: [subdomainResolver({ base: 'basalt.app' })] })
```

### De forma durável — `@basaltkit/tenancy-sqlite` / `-prisma`

Para produção, não faças o contrato à mão — um `TenantSource` durável persiste os
tenants através de um reinício. Ambos trazem `save`/`find`/`findByDomain`/`list`/`remove`:

```ts
import { sqliteTenantSource } from '@basaltkit/tenancy-sqlite'   // nó único, zero-dep
// import { prismaTenantSource } from '@basaltkit/tenancy-prisma' // Postgres/MySQL

const tenants = sqliteTenantSource('./data/tenants.db')

// save() é um upsert — cria ou atualiza um tenant. Qualquer campo extra faz round-trip.
await tenants.save({ id: 'acme', name: 'Acme Inc', plan: 'pro', domains: ['app.acme.com'] })

tenancyPlugin({
  source: tenants,
  resolvers: [subdomainResolver({ base: 'basalt.app' }), domainResolver()],
})
```

`save` substitui o conjunto de domínios personalizados do tenant; um domínio já possuído
por outro tenant é rejeitado (o routing tem de ser inequívoco). Ver [Persistência](/pt/guide/persistence).

::: tip Dica
Registo com backend Prisma. `prismaTenantSource(prisma)` guarda o registo na base de
dados Postgres/MySQL que já corres — ideal para múltiplas instâncias a partilhar uma
lista de tenants. Adiciona os seus dois modelos com `basalt prisma:sync --push`, depois
passa o teu `PrismaClient` gerado. A mesma superfície `save`/`find`/`findByDomain`/`list`/`remove`.
:::

### No sign-up — provisionar um tenant sob demanda

Um SaaS real cria tenants quando um cliente se regista. Fá-lo num serviço/rota:
persiste o registo, depois (para schema- ou database-per-tenant) provisiona o seu
storage, e opcionalmente semeia-o — tudo dentro do contexto do novo tenant.

```ts
import { ctx } from '@basaltkit/core'
import { TENANCY } from '@basaltkit/tenancy'
import { provisionTenantSchema, tenantSchema } from '@basaltkit/prisma'

export async function createTenant(input: { id: string; name: string; domains?: string[] }) {
  // 1. persiste o tenant (o modo shared-database para aqui)
  await tenants.save(input)

  // 2. só schema-per-tenant: cria o seu schema, depois migra-o
  await provisionTenantSchema(db, tenantSchema(input.id))
  //    …corre migrações contra tenant_<id> (ou o comando `basalt tenant:migrate` abaixo)

  // 3. opcionalmente semeia dados iniciais *dentro* do novo tenant
  await app.container.get(TENANCY).run(input.id, async () => {
    await ctx().db.setting.create({ data: { key: 'onboarded', value: 'true' } })
  })

  return input
}
```

Expõe-o como uma rota protegida por admin (`POST /tenants`); o `subdomainResolver` /
`domainResolver` encaminham o tráfego do novo tenant no momento em que o registo existe.

## Ler o tenant

O tenant resolvido vive no contexto do pedido — sem passagem de argumentos. É o
registo aberto que guardaste, portanto qualquer campo personalizado está mesmo ali:

```ts
import { ctx } from '@basaltkit/core'

export async function currentTenant() {
  const tenant = ctx().tenant       // undefined fora de um contexto de tenant
  return {
    id: tenant?.id ?? null,
    name: tenant?.name ?? null,     // qualquer campo que guardaste faz round-trip
    plan: tenant?.plan ?? 'free',
  }
}
```

Define `required: true` no plugin para rejeitar pedidos não resolvidos à partida com um
`404 TENANCY_NOT_RESOLVED` — pedidos mal encaminhados falham ruidosamente em vez de
correrem contra dados globais. Mantém-no `false` para rotas centrais (landing page,
sign-up) e trata o tenant ausente no handler.

Também podes ler o tenant através da fachada `TENANCY` — útil em serviços
que de outra forma não tocam em `ctx()`:

```ts
import { TENANCY } from '@basaltkit/tenancy'

const tenancy = app.container.get(TENANCY)
tenancy.current()          // Tenant | undefined — o tenant do contexto ativo
await tenancy.find('acme') // Tenant | null — procura um por id, ignorando o contexto
```

## Isolamento automático

Não isolas nada à mão. O mesmo código comporta-se por tenant:

```ts
await cache.put('config', value)          // chave prefixada com tenant:<id>
await storage.disk('uploads').put(path, f) // guardado sob tenants/<id>/
await SendEmail.dispatch({ userId })       // tenant restaurado no worker
logger.info('done')                        // o log transporta tenantId
```

## Correr código num tenant

Fora de um pedido — num job, num script, ou em manutenção — não há resolver, por isso
entras num tenant explicitamente. `run()` define `ctx().tenant`, emite
`tenancy:switched` (que reanexa a cache, o storage, o db client… do tenant),
e restaura o contexto circundante depois:

```ts
import { TENANCY } from '@basaltkit/tenancy'
import { ctx } from '@basaltkit/core'

const tenancy = app.container.get(TENANCY)

// Passa um id (carregado da source; lança TenantNotFoundError se desconhecido)
// ou um objeto Tenant que já tenhas.
const total = await tenancy.run('acme', async () => {
  return ctx().db.invoice.count() // com âmbito na Acme
})

// Manutenção em massa: visita cada tenant, cada um no seu próprio contexto, com
// concorrência limitada (padrão 5). Requer source.list().
await tenancy.forEach(async (tenant) => {
  await tenancy.run(tenant, async () => {
    // …trabalho por tenant, totalmente isolado…
  })
}, { concurrency: 5 })
```

Reage a mudanças de contexto em qualquer lugar com o hook:

```ts
app.hooks.on('tenancy:switched', ({ tenant }) => {
  logger.info(`working for tenant ${tenant.id}`)
})
```

## Modos de isolamento

`@basaltkit/prisma` implementa três estratégias de isolamento. O teu código de query
mantém-se `db<PrismaClient>().user.findMany()` nas três — o modo é configuração do
`prismaPlugin`, não uma reescrita. Escolhe um:

| Modo | Como | Isolamento | Quando |
| --- | --- | --- | --- |
| Base de dados partilhada | um client, `tenancyExtension()` adiciona um filtro `tenantId` | lógico | maioria das apps; o mais barato de correr |
| Schema por tenant | uma base de dados, um schema PostgreSQL por tenant | forte | isolamento sem N bases de dados |
| Base de dados por tenant | uma base de dados separada (+ client) por tenant | o mais forte | conformidade, backups por tenant |

**Base de dados partilhada** (padrão) — um client com uma coluna `tenantId` em cada
modelo. A extensão força o filtro do tenant atual em cada leitura, e
carimba-o em cada create — o código não pode esquecer nem sobrepor:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaPlugin, tenancyExtension } from '@basaltkit/prisma'

const db = new PrismaClient().$extends(
  tenancyExtension({
    tenantField: 'tenantId',   // nome da coluna (padrão 'tenantId')
    onMissingTenant: 'bypass',  // sem tenant no contexto → corre sem filtro (central/admin).
                                // 'error' lança em vez disso — isolamento estrito.
  }),
)

prismaPlugin({ client: db })
```

**Schema por tenant** — uma base de dados, um schema PostgreSQL por tenant. Cada
tenant recebe um client cujo URL de ligação transporta `?schema=tenant_<id>`, para que
o Prisma defina o `search_path` no momento da ligação (fiável, ao contrário da troca de
`search_path` por pedido num pool partilhado). Os clients são mantidos num pool LRU
limitado:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaPlugin, provisionTenantSchema, tenantSchema } from '@basaltkit/prisma'

prismaPlugin({
  schemaPerTenant: {
    url: env.DATABASE_URL,
    createClient: (url) => new PrismaClient({ datasourceUrl: url }),
    prefix: 'tenant_',                          // schema = tenant_<id> (padrão)
  },
  destroy: (client) => client.$disconnect(),    // fecha um client despejado do pool
  max: 25,                                       // clients mais-recentemente-usados mantidos abertos (padrão 10)
})

// Provisiona o schema de um novo tenant (uma ligação admin com $executeRawUnsafe):
const admin = new PrismaClient()
await provisionTenantSchema(admin, tenantSchema('acme')) // CREATE SCHEMA IF NOT EXISTS "tenant_acme"
```

**Base de dados por tenant** — uma base de dados (e client) separada por tenant, via o
mesmo pool LRU. Dá-lhe uma factory chaveada por id de tenant:

```ts
prismaPlugin({
  forTenant: (id) => new PrismaClient({ datasourceUrl: urlFor(id) }),
  destroy: (client) => client.$disconnect(),
  max: 20,
})
```

Em todos os modos o plugin anexa o client certo ao contexto em cada pedido HTTP
e dentro de `tenancy.run()` — lê-lo com `db<PrismaClient>()`, que
lança `DB_UNAVAILABLE` fora de um contexto de tenant. Ver
[Database-per-tenant](/pt/guide/database-per-tenant) para a receita completa com pool.

## Migrações por tenant

Schema- e database-per-tenant precisam de migrações corridas para cada tenant.
`migrateTenants` orquestra isso — concorrência limitada, provisionando o schema
primeiro (modo schema), e um relatório por tenant onde uma falha nunca aborta os
restantes. Liga-o como um comando `basalt tenant:migrate`:

```ts
import { tenantMigrateCommand, provisionTenantSchema } from '@basaltkit/prisma'
import { commandsPlugin } from '@basaltkit/cli'

commandsPlugin([
  tenantMigrateCommand({
    tenants: () => tenants.list().then((all) => all.map((t) => t.id)),
    target: {
      mode: 'schema',
      url: env.DATABASE_URL,
      provision: db, // um client com $executeRawUnsafe — CREATE SCHEMA IF NOT EXISTS
    },
  }),
])
```

```bash
basalt tenant:migrate
#  ok   acme (tenant_acme)
#  FAIL globex (tenant_globex) — <error>
#  Done: 1 migrated, 1 failed.
```

O migrator padrão delega para `prisma migrate deploy` com o URL de ligação com âmbito
de cada tenant; passa `migrate` para o sobrepor.
