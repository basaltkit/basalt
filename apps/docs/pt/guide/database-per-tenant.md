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
`PrismaClient` **uma vez, no arranque** — muito antes de existir um pedido. Com
base-por-tenant o cliente certo só se conhece por pedido, portanto o que eles
têm de guardar não é um cliente, é uma forma de lá chegar. É o `tenantClient()`:

```ts
import { tenantClient } from '@basaltkit/prisma'
import type { PrismaClient } from '@prisma/client'
import { prismaAuthStores } from '@basaltkit/auth-prisma'
import { prismaAccessStore } from '@basaltkit/permissions-prisma'
import { prismaCommentsStore } from '@basaltkit/comments-prisma'

// Cada acesso resolve para o cliente do tenant ATIVO. Constrói uma vez.
const tenantDb = tenantClient<PrismaClient>()

const auth = prismaAuthStores(tenantDb)
const access = prismaAccessStore(tenantDb)
const comments = prismaCommentsStore(tenantDb)
```

::: warning Não escrevas este proxy à mão
Um `new Proxy({}, { get: (_t, p) => db()[p] })` de duas linhas parece
equivalente, e para `client.user.findMany()` é. Continua a ser a ferramenta
errada, por duas razões.

Um trap `get` sozinho é só meio cliente. `'user' in client` responde `false`,
`Object.keys(client)` responde `[]` e `Object.getOwnPropertyDescriptor` não
encontra nada — não são erros, são respostas erradas, dadas a qualquer store que
sonde o cliente antes de o usar. O `tenantClient()` implementa `has`, `ownKeys`
e `getOwnPropertyDescriptor` contra o cliente activo, e encaminha o `get` com
`Reflect` para que propriedades accessor vejam o mesmo receiver que veriam no
cliente.

E o erro habitual com um proxy feito à mão nem sequer é o proxy: é passar o
cliente central ao store "por agora", porque um cliente é o que a assinatura
pede. Isso não lança erro nenhum. Todos os tenants lêem e escrevem no schema
central, em silêncio. Uma primitiva que não recebe cliente não deixa nada para
errar.
:::

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

::: tip O modo de base de dados partilhada é mais simples — com uma regra
Se não precisas de isolamento físico, uma base de dados com uma coluna `tenantId`
em todos os modelos e `prisma.$extends(tenancyExtension())` como cliente da app
mantém os tenants separados por linha, sem proxy. A regra: os stores do framework
recebem o cliente **simples**, não o estendido. `auth_users`, `perm_*` e
`tenants` não levam `tenantId` — um login ainda não tem tenant — e a extensão
faz scope de todos os modelos, por isso um cliente estendido faz os stores
lançarem `PRISMA_TENANT_MISSING` no primeiro pedido. É assim que o
`create-basalt` gera o projecto: `prisma` para os stores, `db` (estendido) para o
teu código. A identidade passa a ser global: uma conta em todos os tenants,
acesso por membership. Recorre a database/schema-per-tenant quando o isolamento
tiver de ser físico — ou quando staff e clientes tiverem de ser populações
diferentes, vê [o padrão multi-tenant](/pt/guide/multi-tenant-pattern).
:::

## Servir rotas centrais e de tenant na mesma app

A maioria das apps não é puramente multi-tenant. Há uma landing page, um
formulário de registo, uma área de administração e um health check que não são
de **ninguém** — e as rotas de tenant, que são de exatamente um. Vivem os dois
no mesmo processo.

O `prismaPlugin` cobre isto num único registo: o `client` é usado quando o
contexto não tem tenant, e o modo por tenant quando tem.

```ts
prismaPlugin({
  // Sem tenant resolvido → este cliente (a base central / schema `public`).
  client: prisma,
  // Com tenant resolvido → um cliente ligado com `?schema=tenant_<id>`.
  schemaPerTenant: {
    url: process.env.DATABASE_URL!,
    createClient: (url) => new PrismaClient({ datasourceUrl: url }),
  },
  destroy: (client) => client.$disconnect(),
})
```

O `db()` passa a devolver o cliente certo nos dois tipos de pedido, portanto o
mesmo handler serve os dois sem ramificar:

```ts
route({ method: 'GET', url: '/users', meta: { tenant: false }, handler: async () =>
  db<PrismaClient>().authUser.findMany(),  // central no domínio, tenant no subdomínio
})
```

Em `app.example.com` lista os utilizadores centrais; em `acme.example.com`, os da
Acme. A mesma rota, a mesma query, sem um `if`.

### Rotas que não escreveste

Os pacotes montam as suas próprias rotas — `authRoutes()`, `mfaRoutes()`,
`billingRoutes()` — por isso não lhes podes pôr `meta` à mão. Mapeia-as:

```ts
const central = <T extends { meta?: Record<string, unknown> }>(routes: T[]): T[] =>
  routes.map((r) => ({ ...r, meta: { ...r.meta, tenant: false } }))

fastifyPlugin({ routes: [...central(authRoutes()), ...central(mfaRoutes())] })
```

O `tenant: false` levanta a *exigência*, não a resolução — um pedido a
`acme.example.com/auth/login` continua a resolver a Acme, portanto os stores de
auth leem o schema da Acme. O resultado é um só conjunto de rotas de auth a
servir duas populações:

| Pedido | Autentica contra |
| --- | --- |
| `app.example.com/auth/login` | utilizadores centrais |
| `acme.example.com/auth/login` | utilizadores da Acme |

Um utilizador central não entra num subdomínio de tenant, e um de tenant não
entra no domínio principal — não porque um handler verifique, mas porque os dois
procuram em schemas diferentes.

### O plano central não é um segundo sistema de identidade

É este o ponto que escapa às pessoas, e escapa caro. As pessoas que **operam** o
SaaS — dono, suporte, financeiro, operações — são uma população diferente das
que estão dentro de cada empresa cliente. O mesmo e-mail nos dois sítios não é a
mesma pessoa, e uma conta central nunca deve abrir um tenant.

Essa separação é real e importa. O que ela **não** exige é uma segunda pilha de
autenticação. Como o `db()` segue o plano do pedido, a população central recebe
`authPlugin`, `authRoutes()`, `mfaRoutes()`, recuperação de palavra-passe,
sessões, chaves de API e `permissionsPlugin` — tudo — do registo que já fizeste:

```ts
// prisma/schema.prisma          → o plano CENTRAL (schema public)
model AuthUser  { id String @id  email String @unique  passwordHash String  … }
model AuthSession { … }
model PermUserRole { scope String  userId String  role String  @@id([scope, userId, role]) }
model Tenant  { … }   // o registo de clientes, planos, subscrições, pagamentos

// prisma/tenants/schema.prisma  → o que cada empresa cliente tem de seu
generator client { provider = "prisma-client-js", output = "../../generated/tenant" }
model AuthUser  { id String @id  email String @unique  passwordHash String  … }
model Invoice   { id String @id  … }   // sem tenantId: o schema É o tenant
```

Dois schemas, **dois generators**, dois clientes. O segundo `output` não é
cosmético: com um só cliente os modelos dos dois planos têm de ser declarados no
mesmo schema, e a base central passa a ter tabelas que devem ficar vazias para
sempre — e uma tabela vazia no plano errado é exactamente onde uma escrita
perdida vai parar.

Autorizar a área central é depois o sistema de permissões normal, com um âmbito
próprio:

```ts
import { GLOBAL_SCOPE } from '@basaltkit/permissions'

export const PLATFORM_ADMIN = 'platform_admin'

// Ligado ao cliente CENTRAL explicitamente — isto semeia e atribui fora de
// qualquer pedido, onde o db() não tem plano a seguir e por isso lança.
const centralAccess = prismaAccessStore(prisma).store
await centralAccess.grantToRole(PLATFORM_ADMIN, ['tenant:approve', 'platform:read'], GLOBAL_SCOPE)

route({ method: 'POST', url: '/central/admin/tenants/:id/approve',
        meta: { tenant: false, auth: true, can: 'tenant:approve' }, handler })
```

O scope é `GLOBAL_SCOPE`, não uma string tua. Um pedido sem tenant é avaliado
em `GLOBAL_SCOPE` (`'@global'`) e o Gate não lê mais nada aí: uma atribuição
escrita sob `'global'` — o valor anterior à 1.5 — nunca é consultada, por isso
a rota acima negaria precisamente o administrador que acabaste de criar, e nada
te diz porquê. Vê
[o scope global não pode ser um tenant](/pt/guide/authorization#o-scope-global-nao-pode-ser-um-tenant).

`meta: { tenant: false, auth: true, can: '…' }` — as mesmas três chaves que
qualquer rota de tenant usa. Nomeia o primeiro administrador pela CLI, não por
uma rota: o primeiro não tem quem o nomeie, e um endpoint desprotegido para
«criar o primeiro» é a porta que fica aberta porque ninguém se lembra de a
fechar. Quem corre um comando no servidor já alcança a base de dados.

::: danger O anti-padrão: uma identidade de operador feita à mão
O atalho tentador é um modelo `PlatformOperator` com o seu próprio hashing de
palavra-passe, a sua tabela de sessões, o seu cookie, o seu token CSRF e o seu
`if (role === 'OWNER')`. Escreve-se depressa e parece bom isolamento.

Não é. É uma segunda base de código crítica para a segurança que começa sem nada
do que o framework já te dá, e vais reimplementar cada peça mal e tarde:
recuperação de palavra-passe, TOTP e a sua janela de repetição, links de
convite, bloqueio por tentativas, revogação de sessões, um catálogo de
permissões, um trilho de auditoria. Entretanto quem opera o serviço fica
protegido *pior* do que os clientes a quem o vende — que é ao contrário.

Se te apanhares a escrever `requireOperator()`, pára: a separação que queres é a
que o `db()` já dá, e o `can:` já exprime o resto.
:::

::: warning Isto troca uma falha ruidosa por uma silenciosa
Sem `client`, uma rota de tenant alcançada sem tenant lança `DB_UNAVAILABLE`.
Com o `client` definido, essa mesma rota passaria a consultar a base **central**
em silêncio — o erro continua a acontecer, mas calado e contra os dados errados.

O que mantém isto seguro é recusar o pedido antes de o handler correr: põe
`required: true` no `tenancyPlugin` e marca apenas as rotas que pertencem mesmo
ao contexto central. Vê
[separar rotas centrais de rotas de tenant](/pt/guide/tenancy#separar-rotas-centrais-de-rotas-de-tenant).

Ou seja, o `meta: { tenant: false }` é uma afirmação que fazes sobre a rota:
*esta faz sentido sem tenant.* Marcar assim uma rota que é só de tenant é
precisamente como se constrói o bug de dados errados em silêncio de que esta
opção te está a proteger.
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

### Sair com sucesso não prova que aconteceu alguma coisa

O `prisma migrate deploy` sai com código 0 quando **não** encontra migrações
para aplicar. Se a pasta de migrações não existir ou estiver vazia — um clone
novo, um `.gitignore` que a apanhou, um config a apontar para a errada —, o
tenant é provisionado, o migrator comunica sucesso, e o schema fica com a tabela
`_prisma_migrations` e mais nenhuma. O tenant é marcado como pronto, e o estrago
só aparece muito mais tarde, numa query a uma tabela que nunca foi criada.

O `migrateTenants` verifica isto. Depois de cada tenant migrar, conta as tabelas
no schema desse tenant, ignorando a `_prisma_migrations`, e comunica `ok: false`
quando a contagem é zero:

```
PRISMA_TENANT_SCHEMA_EMPTY: The migration reported success but tenant schema
"tenant_acme" has no tables.
```

Corre em modo schema quando o `provision` também consegue ler a base de dados —
um `PrismaClient` consegue, por isso `provision: admin` chega. É uma query ao
`information_schema` por tenant e, como qualquer outra falha, é comunicada por
tenant sem abortar o resto da execução. Passa `verifyTables: false` se um tenant
começar legitimamente vazio.

::: tip É por isto que a verificação conta tabelas, e não migrações
O `prisma db push` cria as tabelas diretamente a partir do `schema.prisma`, sem
histórico de migrações nenhum. Perguntar "as migrações foram aplicadas?" daria
uma falha falsa nessa estratégia; perguntar "o tenant tem tabelas?" é a pergunta
certa nas duas.
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
