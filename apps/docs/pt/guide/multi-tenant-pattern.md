# O padrão multi-tenant

Uma app, uma stack de autenticação, **dois planos**: o plano central onde o SaaS
é operado, e um plano de tenant por cliente. Cada pedido cai exactamente num
deles, e tudo o resto — que utilizadores existem, que roles se aplicam, que
tabelas uma query consegue alcançar — decorre daí.

Esta página é o padrão para o qual o framework foi construído, escrito como dez
regras contra as quais podes verificar uma base de código. Não é um tutorial: os
guias de [tenancy](/pt/guide/tenancy), [base de dados por
tenant](/pt/guide/database-per-tenant) e [criar um tenant](/pt/guide/creating-a-tenant)
ensinam cada peça. Este diz como as peças têm de encaixar, e o que corre mal
quando não encaixam. As regras vêm da auditoria a três apps de produção
construídas em Basalt, e cada "o que corre mal" abaixo é algo que uma delas
realmente entregou.

[[toc]]

## A forma numa imagem

```
  app.example.com  ──── plano central ────►  public.*          (staff do SaaS, registo de tenants, facturação)
  acme.example.com ──── plano de tenant ──►  tenant_acme.*     (utilizadores da Acme, dados da Acme)
  globex.example.com ── plano de tenant ──►  tenant_globex.*   (utilizadores da Globex, dados da Globex)

  um PostgreSQL · um authPlugin · um permissionsPlugin · o db() escolhe o plano
```

O isolamento é a ligação. Um schema de tenant tem os seus próprios `auth_users`,
as suas próprias tabelas `perm_*` e as suas tabelas de domínio, por isso uma
query no host da Acme não alcança linhas da Globex sem nomear o schema de
propósito. O plano central guarda apenas o que pertence ao operador do SaaS: o
registo de tenants, planos, subscrições, pagamentos, as contas do staff e os
seus roles.

## Regra 1 — Um PostgreSQL, um schema por tenant

```ts
import { prismaPlugin } from '@basaltkit/prisma'
import { PrismaClient as CentralClient } from '../generated/central'
import { PrismaClient as TenantClient } from '../generated/tenant'

export const central = new CentralClient()

prismaPlugin({
  client: central,                                   // o plano central
  schemaPerTenant: {                                 // os planos de tenant
    url: env.DATABASE_URL,
    createClient: (url) => new TenantClient({ datasourceUrl: url }),
  },
  destroy: (client) => client.$disconnect(),
  max: 20,
})
```

`client` é o plano onde cai um pedido sem tenant. `schemaPerTenant` é o plano
onde cai um pedido com tenant. O `db()` devolve o que se aplicar. Nenhum modelo
da app leva `tenantId`, nenhuma query filtra por ele, e não é preciso row-level
security: o schema *é* o tenant.

`forTenant: (id) => createTenantDb(url, id)` é um equivalente aceite quando a
tua factory fixa o schema tanto pelo adapter `{ schema }` como pelo `search_path`
da ligação. Fixa-o num sítio só: cada nome de tabela não qualificado em SQL raw
depende disso.

::: details Quando escolher antes o modo de base de dados partilhada
Uma base de dados com `tenantId` em todos os modelos e `tenancyExtension()` no
cliente da app é mais simples de operar e serve muitos produtos. A troca é que as
tabelas do próprio framework — `auth_users`, `perm_*`, `tenants` — não levam
`tenantId`, por isso os stores recebem o cliente **não estendido** e a
identidade passa a ser global: uma conta em todos os tenants, acesso por
membership. É um modelo de identidade diferente, não uma versão leve deste. Tudo
o que se segue assume o modelo por schema; o guia de [base de dados por
tenant](/pt/guide/database-per-tenant) cobre a ligação em modo partilhado.
:::

## Regra 2 — Dois schemas Prisma, dois generators, dois clientes

```
prisma/
  schema.prisma              → generated/central   Auth*, Perm*, Team*, Tenant, TenantDomain,
                                                   Plan, Subscription, Payment, PlatformSettings
  prisma.config.ts
  tenants/
    schema.prisma            → generated/tenant    Auth*, Perm*, Team*, AuditEntry, + o teu domínio
    prisma.config.ts
    migrations/
```

Dois generators com dois `output`, não um schema com os modelos dos dois planos.
Com um cliente só, a base central ganha todas as tabelas de tenant, vazias para
sempre, e uma tabela vazia no plano errado é exactamente onde uma escrita
perdida vai parar sem ninguém dar por ela. Dois clientes dão-te também dois
tipos, `CentralDb` e `TenantDb`, e o compilador recusa `centralDb().invoice`
antes de um teste o fazer.

O histórico dos tenants migra-se schema a schema com
[`migrateTenants`](/pt/guide/database-per-tenant#migrar-todos-os-tenants) e o
`prisma.config.ts` dos tenants. O histórico central é `prisma migrate deploy`
normal.

## Regra 3 — Resolver pelo host, registar com uma lista reservada

```ts
import { tenancyPlugin, subdomainResolver, domainResolver, headerResolver, isValidTenantId } from '@basaltkit/tenancy'
import { prismaTenantSource } from '@basaltkit/tenancy-prisma'
import { isReservedSlug } from './tenancy/reserved'

tenancyPlugin({
  source: prismaTenantSource(central),
  resolvers: [
    subdomainResolver({ base: env.APP_BASE_HOST }),   // acme.example.com
    domainResolver(),                                 // domínios próprios verificados
    ...(env.NODE_ENV === 'test' ? [headerResolver()] : []),
  ],
  required: true,
  validateTenantId: (id) => isValidTenantId(id) && !isReservedSlug(id),
  canonicalDomain: (tenant) => `${tenant.id}.${env.APP_BASE_HOST}`,
})
```

Há três decisões escondidas nesse bloco.

**O resolver por header é um utensílio de teste.** O `x-tenant-id` deixa um
teste escolher qualquer tenant sem DNS. Também deixa qualquer cliente escolher
qualquer tenant, por isso nunca corre fora de `NODE_ENV === 'test'`. "Não é
produção" não é a mesma condição: o staging corre com outros valores e herda a
porta aberta.

**Uma lista reservada.** `www`, `app`, `api`, `admin`, `central`, `platform`,
`mail`, `static`, `docs`, `status` — os nomes que o teu apex, o host da API e as
páginas de marketing usam. O framework só reserva `global`. Põe a lista num
módulo e usa-a em três sítios: no `validateTenantId` (para o `tenancy.create()`
a recusar), no validador do signup (para o utilizador receber um 400, não um
500) e no resolver de subdomínio se o embrulhares. Duas listas divergem:
encontrámos uma em que o signup permitia `central` e o schema de planos não.

**`canonicalDomain` no plugin, não no ponto de chamada.** O domínio
`<id>.<base>` do tenant é acrescentado pelo próprio `tenancy.create()`.
Embrulhar cada chamada ao `create()` à mão é a versão que se esquece no
terceiro ponto de chamada.

## Regra 4 — Os stores constroem-se uma vez, sobre `tenantClient()`

```ts
import { tenantClient, db } from '@basaltkit/prisma'
import { requireTenantId } from '@basaltkit/tenancy'

// Construído no arranque, resolvido por pedido: auth, permissões, equipas,
// auditoria, notificações — tudo o que existe nos DOIS planos.
export const tenantDb = tenantClient<TenantDb>()

const authStores = prismaAuthStores(tenantDb)
const access = prismaAccessStore(tenantDb).store
const teams = prismaTeamsStores(tenantDb)

// Ligado ao cliente CENTRAL explicitamente: o que existe num plano só.
const tenants = prismaTenantSource(central)
const centralAccess = prismaAccessStore(central).store
const subscriptions = prismaSubscriptionsStores(central)
```

E dois helpers por onde todos os handlers passam em vez de chamar `db()`:

```ts
/** O plano de tenant. Lança TENANT_REQUIRED quando não resolveu tenant. */
export function tenantDb(): TenantDb {
  requireTenantId()
  return db<TenantDb>()
}

/** O plano central. RECUSA um pedido que resolveu tenant. */
export function centralDb(): CentralDb {
  if (ctx().tenant) throw new HttpError(404, 'Not found')
  return central
}
```

O segundo helper é o que as pessoas deixam de fora. `meta: { tenant: false }`
levanta a *exigência* de tenant; não impede a resolução. Uma rota de plataforma
alcançada em `acme.example.com/platform/...` continua com `ctx().tenant` a
apontar para a Acme, e um `centralDb()` que simplesmente devolve `central` passa
a ser a única coisa entre o dono da Acme e as tabelas do operador. A Regra 5
fecha a rota; isto fecha o caminho dos dados. Mantém os dois.

::: danger Nunca recuar para o plano central
`try { return db() } catch { return central }` é a linha mais perigosa que
encontrámos em qualquer das três apps. Estava num adapter de pesquisa: sempre
que um hook corria fora de um pedido, as escritas no índice iam parar em
silêncio ao schema central. Todos os stores do framework falham fechados — o
`db()` lança `DB_UNAVAILABLE` — e um wrapper que apanha isso e escolhe um plano
por conta própria desfaz a garantia para tudo o que está atrás dele. Se um
chamador precisa legitimamente do plano central, dá-lhe uma instância ligada ao
`central`.
:::

## Regra 5 — Três tipos de rota, declarados no `meta`

| Tipo | Declara | Alcançada em | Exemplos |
| --- | --- | --- | --- |
| Rota de tenant (por omissão) | nada | só host de tenant | facturas, documentos, equipa |
| Rota de conta | `tenant: false` | apex **e** hosts de tenant | `authRoutes()`, `mfaRoutes()`, aceitar convite |
| Rota de plataforma | `tenant: false, platform: true, auth: true, can: 'platform:…'` | só apex | aprovar tenant, planos, roles de operador |

As rotas de conta são o caso interessante. `POST /auth/login` no apex autentica
contra `public.auth_users`; a mesma rota em `acme.example.com` autentica contra
`tenant_acme.auth_users`, porque os stores de auth seguem o `db()`. Uma rota,
dois planos, sem ramificação. O framework marca-as com `meta.account`, que o
guard de membership das equipas respeita; embrulha-as uma vez para levarem
também `tenant: false`:

```ts
const central = (r: RouteDef) => ({ ...r, meta: { ...r.meta, tenant: false } })
routes: [...authRoutes().map(central), ...mfaRoutes().map(central), ...appRoutes]
```

As rotas de plataforma precisam de um guard que o framework não fornece, porque
`platform` é uma chave tua, não dele:

```ts
// src/platform/guard.ts — registado como qualquer outro guard
const platformOnly: RouteGuard = async ({ route, context }) => {
  if (route.meta?.['platform'] !== true) return
  if (context.tenant) throw new HttpError(404, 'Not found')
}
metadata.add('http:guards', platformOnly)
```

Porquê 404 e não 403: num host de tenant a consola de plataforma não existe. Um
403 diz ao dono da Acme que há ali algo de que está proibido.

::: warning Os wildcards chegam mais longe do que pensas
Um role `owner` de tenant com `'*'` satisfaz `can: 'platform:tenants:approve'`.
Dentro do plano de tenant isso é inofensivo — as tabelas centrais não estão lá —
até uma rota de plataforma ser servida num host de tenant sem o guard acima.
Encontrámos esta cadeia completa numa app: dono no próprio subdomínio →
`platform:*` satisfeito por `*` → `centralDb()` devolveu o cliente do tenant →
uma escrita de role de operador caiu no schema do tenant e a entrada de
auditoria na cadeia **central**. O guard é o que quebra a cadeia; prefixar as
permissões de plataforma é higiene, não protecção.
:::

O registo em hosts de tenant está fechado: as pessoas entram num tenant por
convite, não por descobrirem o subdomínio. Devolve 404 do `/auth/register`
quando resolveu tenant. O registo no apex ou está fechado também (o staff é
criado pela CLI) ou está aberto mas sem privilégios — uma conta no apex sem role
de plataforma não consegue fazer nada.

## Regra 6 — Uma stack de identidade, duas populações

As pessoas que operam o SaaS e as pessoas dentro de cada cliente são populações
diferentes. O mesmo e-mail nos dois sítios são duas pessoas. Uma conta central
nunca abre um tenant, e uma conta de tenant nunca abre a consola.

Essa separação não custa nada: é o que a Regra 4 já te dá. O `authPlugin` sobre
`tenantDb` põe o staff em `public.auth_users` e os clientes em cada
`tenant_<id>.auth_users`; uma sessão emitida no apex é procurada na tabela
central e não encontra nada num host de tenant. Duas das três apps auditadas
tinham exactamente isto, com testes a provar que um cookie central é 401 num
tenant e vice-versa.

A terceira tinha escrito um modelo `PlatformOperator` com o seu próprio hashing
scrypt, a sua própria tabela de sessões, o seu cookie, CSRF, lockout e TOTP
cifrado. Funcionava. Era também uma segunda base de código crítica para a
segurança, menos testada que a primeira, e os operadores que protegia — as
pessoas com mais poder — eram os que tinham menos protecções do framework. A
[caixa de anti-padrão](/pt/guide/database-per-tenant#o-plano-central-nao-e-um-segundo-sistema-de-identidade)
no guia de base de dados por tenant é essa app.

Dois corolários:

- **Os utilizadores criam-se pelo `AUTH`, nunca a fazer hash e inserir.** Um
  fluxo de signup que escreve `authUser.create({ passwordHash })` à mão salta a
  política de passwords, a versão do token e todos os hooks de que uma feature
  futura vai depender.
- **A política de MFA cobre o plano central.** Uma política que começa por
  `if (!ctx().tenant) return` protege todos os clientes e nenhum operador.
  Exprime-a uma vez através de `authPlugin({ requireMfa })` e faz com que
  responda também pelos roles de plataforma.

## Regra 7 — Um sistema de permissões, com scope por plano

```ts
import { GLOBAL_SCOPE } from '@basaltkit/permissions'

// Roles de tenant: semeados no scope do TENANT, dentro do provisionamento.
onProvision: async (tenant) => {
  await provisionTenantSchema(central, tenantSchema(tenant.id))
  await migrateTenants({ tenants: [tenant.id], /* … */ })
  await seedRoles(access, tenant.id)            // partner, admin, member, … sob tenant.id
}

// Roles de plataforma: atribuídos em GLOBAL_SCOPE, pelo store de acesso CENTRAL.
await centralAccess.grantToRole('platform_admin', ['platform:tenants:approve', 'platform:read'], GLOBAL_SCOPE)
```

Os roles vivem onde vivem os dados. Os roles de um tenant são linhas nas
tabelas `perm_*` desse tenant sob o id do tenant; os roles da plataforma são
linhas em `public.perm_*` sob `GLOBAL_SCOPE`. Como os schemas são separados, uma
atribuição `@global` no plano central é invisível dentro de todos os tenants — o
que é o comportamento que queres, e o oposto do modo partilhado, onde uma
atribuição global se aplica em todo o lado.

`GLOBAL_SCOPE` importa-se, nunca se escreve. É `'@global'`; a string anterior à
1.5, `'global'`, é um valor reservado que o Gate já não lê, por isso uma
atribuição escrita sob ela é uma atribuição que nunca se aplica. Vê [o scope
global não pode ser um tenant](/pt/guide/authorization#o-scope-global-nao-pode-ser-um-tenant).

As rotas dizem `can:`. Os handlers não dizem `if (roles.includes('owner'))`. Uma
app tinha nove verificações dessas espalhadas pelos serviços; cada uma é uma
permissão que o catálogo não conhece e que a consola não consegue revogar.
Quando a decisão é mesmo sobre o role e não sobre uma permissão — "o último
owner não se pode despromover" — mantém-na, e mantém-na rara.

Se o código da app precisa do scope actual fora de uma rota, precisa dele num
sítio só:

```ts
export const currentScope = () => ctx().tenant?.id ?? GLOBAL_SCOPE
```

Sete cópias dessa linha são sete sítios para errar o fallback.

## Regra 8 — As primeiras contas vêm da CLI e do provisionamento

**Primeiro administrador de plataforma.** Um comando da app, porque o framework
não pode conhecer os nomes dos teus roles:

```ts
// src/platform/commands.ts — registado com commandsPlugin
{
  name: 'platform:admin',
  args: ['email'],
  run: async ({ email }) => {
    const user = await centralAuth.users.findByEmail(email)   // uma conta central EXISTENTE
    if (!user) throw new Error(`sem conta central para ${email}; regista no apex primeiro`)
    await centralAccess.assignRole(user.id, 'platform_admin', GLOBAL_SCOPE)
  },
}
```

Não uma rota: o primeiro admin não tem quem o autorize, e um endpoint
desprotegido de "criar o primeiro admin" é o que fica aberto. Também não uma
variável de ambiente com password de bootstrap: acaba num ficheiro de deploy, e
quem lê o ficheiro é operador. Quem pode correr um comando no servidor já tem a
base de dados.

**Primeiro owner de tenant.** Criado *dentro do plano de tenant*, no momento em
que o tenant fica pronto:

```ts
const tenant = await tenancy.create({ id: slug, name })         // provisiona o schema
await tenancy.run(tenant.id, async () => {
  const owner = await auth.register({ email, password })        // cai em tenant_<slug>.auth_users
  await access.assignRole(owner.id, 'owner', tenant.id)
  await teams.addMember(tenant.id, owner.id, 'owner')
})
```

A pessoa que se registou no apex pode manter também uma conta central — para a
facturação, para ver todas as empresas que possui — mas isso é uma segunda
conta por desenho, ligada por um id no registo do tenant, não a mesma linha.

## Regra 9 — Fora de um pedido, o tenant é explícito

```ts
await tenancy.run(tenantId, () => reindex())          // um tenant
await tenancy.forEach((tenant) => sendReminders())     // todos os tenants, em contexto
```

Os jobs levam `tenantId` no payload e repõem-no com `tenancy.run` antes de tocar
no `db()`; a integração com a queue faz isso por ti. Scripts e comandos da CLI
recebem `--tenant` e fazem o mesmo. Nada abre o seu próprio
`new TenantClient(url)` fora do pool do plugin: contorna o tecto de ligações, o
hook `destroy` e todos os listeners de `tenancy:switched`.

Um ciclo sobre tenants salta os que não estão `ready`. Uma verificação de
suspensão que só dispara quando existe um id de pedido protege a superfície
HTTP e deixa todos os jobs em segundo plano a retransmitir dados de um cliente
suspenso.

## Regra 10 — Os testes de isolamento

Uma app multi-tenant sem estes testes é uma app multi-tenant cujo isolamento é
uma crença. Cada um leva dez linhas com `@basaltkit/testing`.

1. Um token emitido no tenant A, apresentado no host do tenant B → 401.
2. O mesmo e-mail registado em A e em B → duas contas, dois ids.
3. Um host que não resolve para tenant nenhum → 404.
4. Uma sessão central num host de tenant → 401. Uma sessão de tenant no apex → 401.
5. Um owner de tenant a chamar uma rota de plataforma no próprio host → 404.
6. O `public` não contém nenhuma das tabelas de conteúdo de tenant (verifica no arranque também).
7. Para pelo menos um módulo de domínio: A não lê, altera nem apaga linhas de B,
   e apagar um utilizador em A deixa B intacto.

O quinto é o teste que nenhuma das três apps tinha, e o que teria apanhado a
cadeia da Regra 5.

## Checklist

Cola isto no pull request que introduz tenancy, e outra vez no que acrescenta a
consola de plataforma.

- [ ] `prismaPlugin({ client: central, schemaPerTenant | forTenant })` — dois planos
- [ ] dois `schema.prisma`, dois generators, dois tipos de cliente
- [ ] resolvers: subdomínio, domínio; header só sob `NODE_ENV === 'test'`
- [ ] `required: true`; `meta.tenant: false` só em rotas de conta e de plataforma
- [ ] um módulo de slugs reservados usado pelo `validateTenantId` e pelo signup
- [ ] `canonicalDomain` definido no plugin
- [ ] todos os stores dos dois planos construídos sobre `tenantClient()`; todos os stores centrais ligados a `central`
- [ ] `tenantDb()` exige tenant; `centralDb()` recusa-o
- [ ] nenhum `catch { return central }` em lado nenhum
- [ ] rotas de plataforma declaram `platform: true` e um guard devolve 404 num host de tenant
- [ ] `/auth/register` é 404 em hosts de tenant
- [ ] um `authPlugin`; sem modelo de operador, sem segunda tabela de sessões
- [ ] utilizadores criados pelo `AUTH`, nunca inseridos com hash feito à mão
- [ ] a política de MFA responde pelos roles de plataforma
- [ ] roles de tenant semeados sob o id do tenant no `onProvision`; roles de plataforma sob `GLOBAL_SCOPE` (importado) pelo store central
- [ ] `can:` nas rotas; verificações por nome de role justificadas num comentário
- [ ] comando CLI `platform:admin <email>`; sem rota de bootstrap, sem password de bootstrap em env
- [ ] primeiro owner criado dentro de `tenancy.run` no provisionamento
- [ ] trabalho em segundo plano usa `tenancy.run` / `forEach`, salta tenants não prontos, não abre clientes ad-hoc
- [ ] os sete testes de isolamento

## O que este padrão não decide

Isto é teu, e o framework não tem opinião para lá dos hooks que te dá:

- **Apagar um tenant.** O `tenancy.destroy()` corre o `onDeprovision` no
  contexto do tenant; largar o schema, purgar storage e pesquisa, e o que a
  auditoria guarda são política tua.
- **Suspensão.** Um `status` no registo do tenant mais um listener de
  `tenancy:switched` que o recusa. Decide se o trabalho em segundo plano continua.
- **Acesso de suporte.** Um operador a agir dentro de um tenant é uma sessão de
  tenant criada para ele por uma rota de plataforma auditada, nunca uma sessão
  central que o guard de membership foi mandado isentar.
- **Dono da facturação.** Planos, subscrições e pagamentos são dados do plano
  central indexados por id de tenant; o plano de tenant lê os seus
  entitlements, nunca os escreve.
