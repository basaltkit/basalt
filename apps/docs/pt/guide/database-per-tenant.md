# Database-per-tenant

O isolamento de tenant mais forte é **físico**: os dados de cada tenant vivem na sua
própria base de dados (ou no seu próprio schema PostgreSQL), pelo que um tenant nunca
consegue ler as linhas de outro — a fronteira é a conexão, não um `WHERE tenant_id = ?`
que tens de te lembrar em cada query. `@basaltkit/prisma` dá-te um pool de clientes
por tenant, e os [`*-prisma` stores](/pt/guide/persistence) duráveis assentam por cima,
por isso **todos** os domínios com estado — auth, permissões, comentários, audit, tudo
— ficam isolados por tenant de graça.

[[toc]]

## Três modelos de isolamento

| Modelo | Como | Isolamento | Quando |
| --- | --- | --- | --- |
| DB partilhada, scope por linha | um cliente, `tenancyExtension()` adiciona filtros `tenant_id` | lógico | a maioria das apps; o mais barato de correr |
| **Schema-per-tenant** | uma base de dados, um schema PostgreSQL por tenant | forte | isolamento sem N bases de dados — **só PostgreSQL**, vê [compatibilidade](#que-estrategia-funciona-em-que-base-de-dados) |
| **Database-per-tenant** | uma base de dados separada por tenant | o mais forte | conformidade, noisy-neighbor, backups por tenant |

`prismaPlugin` suporta os três. Este guia cobre os dois últimos — onde o *cliente*
por tenant é a fronteira de isolamento — e como os stores duráveis assentam sobre ele.

## Que estratégia funciona em que base de dados

O Basalt é agnóstico à base de dados onde a estratégia o permite, e honesto onde
não permite. Dois dos três modelos de isolamento funcionam em qualquer conector
do Prisma; o terceiro é uma funcionalidade do PostgreSQL e não é abstraída.

| Estratégia | PostgreSQL | MySQL / MariaDB | SQLite | Usa em alternativa |
| --- | :---: | :---: | :---: | --- |
| **Base partilhada + `tenant_id`** | ✅ | ✅ | ✅ | — é o default, e é totalmente portável |
| **Database-per-tenant** | ✅ | ✅ | ✅ (um ficheiro por tenant) | — a `urlFor()` é tua, por isso qualquer conector serve |
| **Schema-per-tenant** | ✅ | ❌ | ❌ | **`mode: 'database'`** |
| **Row-Level Security** (defesa em profundidade) | ✅ | ❌ | ❌ | o scoping por `tenant_id` sozinho, que já falha fechado |

### Porque é que o schema-per-tenant é só PostgreSQL

Assenta em duas coisas que o PostgreSQL tem e as outras não: um **schema** como
espaço de nomes *dentro* de uma base de dados, e uma ligação cujo `search_path` o
seleciona. O Basalt usa o parâmetro `?schema=` do Prisma para o segundo e o
`CREATE SCHEMA IF NOT EXISTS` para o primeiro.

Em MySQL um "schema" **é** uma base de dados — as palavras são sinónimos — logo
não há nada para separar *dentro* de uma base. O SQLite não tem equivalente
nenhum.

Deliberadamente **não** disfarçamos isto. Uma abstração que transformasse em
silêncio o `mode: 'schema'` numa base separada em MySQL estaria a fazer
database-per-tenant com um nome que diz o contrário: outra história de backups,
outros limites de ligações, outro custo de migração. Escolher isso tem de ser
decisão tua, escrita na tua configuração, e não uma tradução que nunca viste.

**Em MySQL, escolhe `mode: 'database'`.** Dá-te isolamento mais forte do que o
schema-per-tenant de qualquer forma, e é totalmente suportado.

### Porque é que o RLS é só PostgreSQL

O `CREATE POLICY`, o `ALTER TABLE … ENABLE ROW LEVEL SECURITY` e o
`current_setting()` não têm equivalente em MySQL nem em SQLite. O RLS é defesa em
profundidade *por baixo* do scoping por `tenant_id`, nunca um substituto — por
isso uma app sem ele não está desprotegida, tem apenas uma camada em vez de duas.

## O pool de clientes por tenant

Dá ao `prismaPlugin` uma factory e ele mantém um pool LRU limitado de clientes, um por
tenant, construindo-os a pedido:

```ts
import { PrismaClient } from '@prisma/client'
import { prismaPlugin } from '@basaltkit/prisma'

// database-per-tenant: um cliente por connection string de tenant
prismaPlugin({
  forTenant: (tenantId) => new PrismaClient({ datasourceUrl: urlFor(tenantId) }),
  destroy: (client) => client.$disconnect(),
  max: 20, // clientes usados mais recentemente mantidos abertos
})
```

Schema-per-tenant é uma base de dados com um schema por tenant — passa o URL base e
uma factory de cliente, e a Basalt define `?schema=tenant_<id>` por tenant para que o
Prisma troque o `search_path` no momento da conexão (fiável, ao contrário da troca por
request num pool partilhado):

```ts
prismaPlugin({
  schemaPerTenant: {
    url: process.env.DATABASE_URL!,
    createClient: (url) => new PrismaClient({ datasourceUrl: url }),
    prefix: 'tenant_', // nome do schema = tenant_<id>
  },
  destroy: (client) => client.$disconnect(),
})
```

Em ambos os casos, o plugin anexa o cliente certo ao contexto do pedido — em pedidos
HTTP (a partir do tenant resolvido) e dentro de `tenancy.run()` (workers, jobs).
Lê-lo com `db()`:

```ts
import { db } from '@basaltkit/prisma'
import type { PrismaClient } from '@prisma/client'

route({ method: 'GET', url: '/projects', handler: () =>
  db<PrismaClient>().project.findMany(), // a base de dados deste tenant, automaticamente
})
```

`db()` lança `DB_UNAVAILABLE` fora de um contexto de tenant, pelo que uma operação sem
scope falha ruidosamente em vez de tocar silenciosamente nos dados errados.

## Provisionar um novo tenant

Antes do primeiro pedido de um tenant, o storage dele tem de existir. Declara-o
uma vez como `onProvision` no `tenancyPlugin` e todos os caminhos de criação o
correm — vê [No sign-up](/pt/guide/tenancy#no-sign-up-—-provisionar-um-tenant-sob-demanda):

```ts
tenancyPlugin({
  source, resolvers,
  async onProvision(tenant) {
    const admin = new PrismaClient()
    await provisionTenantSchema(admin, tenantSchema(tenant.id))
    await migrateTenants({
      tenants: [tenant.id],
      target: { mode: 'schema', url: process.env.DATABASE_URL!, provision: admin },
    })
  },
})

await tenancy.create({ id, name })   // persiste → provisiona → emite tenancy:created
```

Os mesmos passos escritos à mão, quando os queres fora do plugin:

```ts
import { PrismaClient } from '@prisma/client'
import { provisionTenantSchema, tenantSchema, migrateTenants } from '@basaltkit/prisma'

export async function provisionTenant(id: string, name: string) {
  await tenants.save({ id, name })                 // 1. regista no TenantSource

  // 2. schema-per-tenant: cria o schema numa conexão de admin
  const admin = new PrismaClient()
  await provisionTenantSchema(admin, tenantSchema(id)) // CREATE SCHEMA IF NOT EXISTS "tenant_<id>"

  // 3. põe a sua estrutura em dia (fatia single-tenant do migrator)
  await migrateTenants({
    tenants: [id],
    target: { mode: 'schema', url: process.env.DATABASE_URL!, provision: admin },
  })
}
```

Assim que o registo existe, `subdomainResolver` / `domainResolver` encaminham o
tráfego do novo tenant imediatamente, e o pool constrói o seu cliente no primeiro uso.

## Stores duráveis, um por tenant

Aqui está o retorno. Os [`*-prisma` stores](/pt/guide/persistence) recebem um
`PrismaClient`. Em vez de um cliente fixo, dá-lhes um pequeno **proxy que resolve
`db()` no momento da chamada** — para que cada operação de store corra contra a base de
dados de qualquer que seja o tenant ativo no pedido atual:

```ts
import { db } from '@basaltkit/prisma'
import type { PrismaClient } from '@prisma/client'
import { prismaAuthStores } from '@basaltkit/auth-prisma'
import { prismaAccessStore } from '@basaltkit/permissions-prisma'
import { prismaCommentsStore } from '@basaltkit/comments-prisma'

// Cada acesso a modelo resolve para o cliente do tenant ATIVO. Constrói uma vez.
const tenantDb = new Proxy({} as PrismaClient, {
  get: (_t, model: string) => (db() as unknown as Record<string, unknown>)[model],
})

const auth = prismaAuthStores(tenantDb)
const access = prismaAccessStore(tenantDb)
const comments = prismaCommentsStore(tenantDb)
```

Agora liga-os aos seus plugins como de costume. `tenancyPlugin` resolve o tenant;
`prismaPlugin({ forTenant })` faz pool de um cliente por tenant e coloca-o no contexto
— por isso os stores acima vão parar à base de dados certa em cada pedido:

```ts
createApp({
  plugins: [
    tenancyPlugin({
      source: tenants, // o teu TenantSource durável (sqlite/prisma) — vê Multi-tenancy
      resolvers: [subdomainResolver({ base: 'myapp.com' })],
    }),
    prismaPlugin({
      forTenant: (id) => new PrismaClient({ datasourceUrl: urlFor(id) }),
      destroy: (client) => client.$disconnect(),
      max: 20,
    }),
    authPlugin({ secret, users: auth.users, sessions: auth.sessions,
                 refreshTokens: auth.refreshTokens, tokens: auth.tokens, mfa: auth.mfa }),
    apiKeysPlugin({ store: auth.apiKeys, users: auth.users }),
    permissionsPlugin({ store: access.store }),
    commentsPlugin({ store: comments.store }),
  ],
})
```

Um login em `acme.myapp.com` lê e escreve utilizadores na base de dados da **acme**; o
mesmo código em `globex.myapp.com` atinge a da globex. Nenhum store transporta uma
coluna `tenant_id`, nenhuma query precisa de um filtro de tenant — o isolamento é a
conexão. Porque `db()` lança fora de um contexto de tenant, uma operação que não esteja
com scope de um tenant falha ruidosamente em vez de tocar silenciosamente nos dados
errados.

::: tip O modo de base de dados partilhada é mais simples
Se não precisas de isolamento físico, passa um único `client` (estendido com
`tenancyExtension()`) ao `prismaPlugin` e às factories de store diretamente — sem
proxy. O scope ao nível da linha mantém os tenants separados com uma base de dados.
Recorre a database/schema-per-tenant quando a garantia de isolamento tiver de ser
física.
:::

## Migrar todos os tenants

N bases de dados significa que uma mudança de schema tem de chegar a todas elas.
`migrateTenants` corre uma migração por todos os tenants com concorrência limitada,
reportando cada resultado sem deixar que uma falha aborte o resto. Escolhe o target que
corresponde ao teu modo:

```ts
import { PrismaClient } from '@prisma/client'
import { migrateTenants } from '@basaltkit/prisma'

const ids = (await tenants.list()).map((t) => t.id)

// Database-per-tenant: deriva o URL de conexão de cada tenant.
const results = await migrateTenants({
  tenants: ids,
  target: { mode: 'database', urlFor: (id) => urlFor(id) },
  concurrency: 5,
  onResult: (r) => console.log(r.tenantId, r.ok ? 'ok' : r.error),
})

// Schema-per-tenant em alternativa: um URL base, e um cliente de admin que possa
// CREATE SCHEMA IF NOT EXISTS antes de migrar.
const admin = new PrismaClient()
await migrateTenants({
  tenants: ids,
  target: { mode: 'schema', url: process.env.DATABASE_URL!, provision: admin },
})
```

O migrator predefinido delega em `prisma migrate deploy` com o URL scoped de cada
tenant como `DATABASE_URL`; passa a tua própria função `migrate` para o substituir.

### Onde vivem as migrações dos tenants

Os tenants costumam ter o seu próprio ficheiro de schema e, por isso, o seu
próprio histórico de migrações — separado do central. Apontar para os *modelos*
do tenant não chega para apanhar as *migrações* do tenant:

```ts
// Errado: o --schema muda os modelos, mas o `migrations.path` pertence ao teu
// prisma.config.ts, por isso o Prisma continua a aplicar o histórico CENTRAL.
prismaMigrator({ schemaPath: './prisma/tenants/schema.prisma' })
```

O sintoma é inconfundível assim que o conheces: um tenant acabado de provisionar
fica com a tabela `_prisma_migrations` e nem uma tabela sua. O Prisma aplicou um
histórico que nada tem a ver com estes modelos.

Dá aos tenants um config que fixe os dois, e passa `configPath`:

```ts
// prisma/tenants/prisma.config.ts
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  // Relativo à pasta DESTE ficheiro — não à raiz do projeto. O config na raiz
  // usa caminhos relativos à raiz, o que torna isto fácil de falhar.
  schema: 'schema.prisma',
  migrations: { path: 'migrations' },
  datasource: { url: env('DATABASE_URL') },
})
```

```ts
prismaMigrator({ configPath: './prisma/tenants/prisma.config.ts' })
```

Gera essa primeira migração a partir do schema do tenant com
`prisma migrate diff --from-empty --to-schema-datamodel prisma/tenants/schema.prisma --script`.

::: tip O Prisma ignora o `.env` quando carrega um config
Por isso o config tem de ler o URL do ambiente, como acima. O `prismaMigrator`
define sempre `DATABASE_URL` com o URL scoped do tenant, portanto o
`env('DATABASE_URL')` resolve para o tenant certo em cada execução.
:::

Liga-o como um comando de CLI com `tenantMigrateCommand(...)` para que o `deploy` possa
correr `basalt tenant:migrate` depois de enviar novos modelos de store (os modelos
`Auth*`, `Perm*`, `Comment` … do schema de referência de cada pacote `*-prisma`).
Imprime um relatório `ok`/`FAIL` por tenant e sai com código diferente de zero se algum
tenant falhar — ideal para CI/CD:

```ts
import { tenantMigrateCommand } from '@basaltkit/prisma'
import { commandsPlugin } from '@basaltkit/cli'

commandsPlugin([
  tenantMigrateCommand({
    tenants: () => tenants.list().then((all) => all.map((t) => t.id)),
    target: { mode: 'database', urlFor: (id) => urlFor(id) },
  }),
])
```

## Seeding e trabalho em segundo plano

Fora de um pedido HTTP não há tenant no contexto, por isso `db()` lançaria. Entra num
explicitamente com `tenancy.run()` — emite `tenancy:switched`, que anexa o cliente
desse tenant — ou varre-os todos com `tenancy.forEach()`:

```ts
// seed de um tenant
await tenancy.run('acme', async () => {
  await access.store.grantToRole('admin', ['*'], 'acme')
})

// um job noturno por todos os tenants
await tenancy.forEach(async (tenant) => {
  const stale = await auth.sessions /* … a tua manutenção … */
}, { concurrency: 5 })
```

As mesmas instâncias de store (`auth`, `access`, …) funcionam em todos os contextos —
o proxy encaminha cada chamada para o tenant que o `run`/`forEach` colocou em scope.

## Juntar tudo

A forma completa de uma app database-per-tenant na Basalt:

1. **`tenancyPlugin`** resolve o tenant (subdomínio, header, rota, …).
2. **`prismaPlugin({ forTenant })`** constrói/faz pool de um cliente por tenant e
   coloca-o no contexto.
3. Um **proxy `tenantDb`** transforma `db()` num `PrismaClient` estável sobre o qual
   podes construir stores uma vez.
4. Os **`*-prisma` stores** sobre esse proxy dão a cada domínio — auth, teams,
   subscrições, permissões, comentários, audit, atividade, notificações — o seu próprio
   lar isolado e durável por tenant.
5. **`migrateTenants` / `tenantMigrateCommand`** mantêm o schema de cada tenant em
   sincronia no deploy.

Escreves handlers comuns; a fronteira do tenant é imposta pela conexão, não pela
disciplina. Vê [Persistence](/pt/guide/persistence) para o catálogo de stores e
[Multi-tenancy](/pt/guide/tenancy) para a resolução de tenants.
