# Multi-tenancy

`@basaltkit/tenancy` torna cada pedido ciente do tenant: um **resolver** identifica
o tenant a partir do pedido recebido, uma **`TenantSource`** carrega o seu registo, e
o resultado vive no contexto do pedido — onde a cache, o storage, a queue, o logger e
o teu client Prisma o apanham automaticamente. É desacoplado da auth e das teams:
resolver um tenant responde a *qual* tenant diz respeito o pedido, nunca a *se quem
chama pode agir sobre ele*.

[[toc]]

## Modelo mental

Quatro peças, pela ordem em que correm:

| Peça | Corre | Responsabilidade |
| --- | --- | --- |
| `TenantResolver` | por pedido, pela ordem em que os listas | Mapeia o pedido para um `TenantRef` — `{ id }` ou `{ domain }` |
| `TenantSource` | assim que um resolver produz uma referência | Carrega o registo do tenant (`find` / `findByDomain`). Uma referência que não carrega nada cai para o resolver **seguinte** |
| `ctx().tenant` | no resto do pedido | O registo aberto resolvido — `undefined` quando nada correspondeu |
| `tenancy:switched` | em cada entrada num tenant | Permite à cache, ao storage e ao db client reanexar a sua instância por tenant |
| `tenancy:created` | `{ tenant }` — emitido quando um tenant novo é criado **e provisionado**, portanto um listener pode assumir que o storage dele existe. Não dispara se o `onProvision` lançar |
| `tenancy:created` | uma vez, depois de um tenant novo ser criado **e provisionado** | Email de boas-vindas, entrada de auditoria, notificar um painel — um listener pode assumir que o storage do tenant já existe |

Fora de um pedido não há resolver, por isso entras num tenant explicitamente com
`tenancy.run(id, fn)` — jobs, comandos da CLI e scripts de manutenção passam todos
por aí, e o mesmo hook dispara.

::: danger A resolução é identificação, nunca autorização
Um tenant resolvido apenas diz a que tenant o pedido *alega* dizer respeito. Não
verifica que quem chama lhe pertence — com o `headerResolver`, um utilizador
autenticado do tenant A pode simplesmente enviar `x-tenant-id: b`. Impõe a filiação
à parte com o `tenantMembershipPlugin` das [Teams](/pt/guide/teams), que rejeita
não-membros em toda a app com `403 TEAM_NOT_A_MEMBER`.
:::

## Arranque rápido

Uma app completa que arranca e serve uma rota ciente do tenant:

```ts
import { createApp, ctx } from '@basaltkit/core'
import { fastifyPlugin, route, FASTIFY } from '@basaltkit/fastify'
import { tenancyPlugin, MemoryTenantSource, headerResolver } from '@basaltkit/tenancy'

const app = await createApp({
  plugins: [
    tenancyPlugin({
      source: new MemoryTenantSource().add({ id: 'acme', name: 'Acme Inc', plan: 'pro' }),
      resolvers: [headerResolver()], // x-tenant-id: acme
    }),
    fastifyPlugin({
      routes: [
        route({
          method: 'GET',
          url: '/whoami',
          async handler() {
            const tenant = ctx().tenant
            return { tenant: tenant?.id ?? null, plan: tenant?.plan ?? 'free' }
          },
        }),
      ],
    }),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
```

```bash
curl http://localhost:3000/whoami -H 'x-tenant-id: acme'
# → {"tenant":"acme","plan":"pro"}
curl http://localhost:3000/whoami
# → {"tenant":null,"plan":"free"}   (nenhum tenant resolvido — ver `required` abaixo)
```

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
import { CustomDomains, findByVerifiedDomain } from '@basaltkit/tenancy'

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

Um SaaS real cria tenants quando um cliente se regista, e quem carrega em
**Criar** num painel normalmente não tem nem o conhecimento nem o acesso para
correr uma migração a seguir. Declara o `onProvision` **uma vez**, e todos os
caminhos de criação — uma rota de admin, o `basalt tenant:create`, um script de
seed — passam a trazer o storage do tenant à existência antes de alguém lhe
poder encaminhar um pedido.

```ts
// src/app.ts
import { provisionTenantSchema, tenantSchema, migrateTenants } from '@basaltkit/prisma'

tenancyPlugin({
  source,
  resolvers: [subdomainResolver({ base: 'example.com' })],

  async onProvision(tenant) {
    const admin = new PrismaClient()
    await provisionTenantSchema(admin, tenantSchema(tenant.id))   // CREATE SCHEMA IF NOT EXISTS
    await migrateTenants({
      tenants: [tenant.id],
      target: { mode: 'schema', url: process.env.DATABASE_URL!, provision: admin },
    })
  },
})
```

Depois cria através do **serviço**, nunca através da source:

```ts
// src/modules/tenants/tenants.routes.ts
route({
  method: 'POST',
  url: '/tenants',
  meta: { auth: true },                       // protegida por admin
  body: z.object({ id: z.string().min(1), name: z.string() }),
  async handler({ body }) {
    // persiste → provisiona → emite tenancy:created, por esta ordem
    return ctx().container.get(TENANCY).create(body)
  },
})
```

```bash
basalt tenant:create acme --name=Acme
# → Created and provisioned tenant "acme".
```

::: warning O `source.create()` salta tudo isto
A source só escreve a linha. Um tenant cujo registo existe mas cujo schema não
existe é encaminhável **imediatamente** — o `subdomainResolver` manda-lhe tráfego
no momento em que é gravado — e o primeiro pedido morre num erro cru da base de
dados. Passar pelo `tenancy.create()` é o que fecha essa janela.
:::

O `onProvision` corre dentro do contexto do novo tenant, portanto o
`ctx().tenant` e qualquer cliente com scope de tenant resolvem corretamente — o
mesmo contrato do `onMigrate` e do `onSeed`. Semear dados iniciais também
pertence aqui:

```ts
async onProvision(tenant) {
  await provisionTenantSchema(admin, tenantSchema(tenant.id))
  await migrateTenants({ tenants: [tenant.id], target })
  await ctx().db.setting.create({ data: { key: 'onboarded', value: 'true' } })
}
```

Reage ao tenant já pronto com o hook — ele só dispara depois de o
provisionamento ter tido sucesso, por isso podes tocar nos dados do novo tenant
com segurança:

```ts
app.hooks.on('tenancy:created', async ({ tenant }) => {
  await mailer.send({ to: owner(tenant), subject: `${tenant.name} está pronto` })
})
```

::: danger Faz o `onProvision` idempotente
Se ele lançar, o erro chega a quem chamou e o `tenancy:created` **não** dispara —
mas o registo do tenant já foi escrito, porque a source persiste primeiro. Esse
meio-estado não é revertido de propósito: nem toda a `TenantSource` sabe apagar,
e um delete falhado por cima de um provisionamento falhado destrói a evidência.
Escreve-o de forma a que uma nova tentativa consiga terminar o trabalho —
`CREATE SCHEMA IF NOT EXISTS`, `migrate deploy`.

Também corre **inline**: um handler HTTP que chame `create()` espera pela
migração toda. Isso é aceitável para um schema e um punhado de migrações, e
errado para qualquer coisa lenta — passa a parte lenta para um job em fila e
deixa a rota responder.
:::

### Quando o provisionamento é mais longo que o pedido

O `onProvision` corre inline por omissão: o `create()` espera por ele, e quem
chama sabe que o tenant está utilizável quando a chamada retorna. É o certo para
um schema e um punhado de migrações, e errado assim que o trabalho passa a durar
mais do que um pedido HTTP.

Passa a `provision: 'deferred'` e o `create()` retorna assim que o registo é
escrito, marcado como `provisioning`:

```ts
tenancyPlugin({ source, resolvers, onProvision, provision: 'deferred' })
```

```ts
const tenant = await tenancy.create({ id: 'acme' })
tenant.status                                    // 'provisioning'
// …e os pedidos para ele recebem 503
```

**Nada é agendado por ti, e isso é de propósito.** O trabalho em segundo plano
corre noutro processo, onde um closure deste não chega — por isso o worker
volta a entrar com o id:

```ts
// jobs/provision-tenant.ts
export const ProvisionTenant = defineJob({
  name: 'tenant.provision',
  handle: ({ id }: { id: string }) => ctx().container.get(TENANCY).provision(id),
})

// onde quer que cries o tenant
await tenancy.create({ id })                     // retorna já, em 'provisioning'
await ctx().container.get(QUEUE).dispatch(ProvisionTenant, { id })
```

O `provision(id)` corre o `onProvision`, muda o estado para `ready` e emite o
`tenancy:created` — a mesma meta que o caminho inline atravessa. Mantém-no
idempotente: depois de uma falha o estado fica `failed`, e uma nova tentativa
tem de conseguir terminar o trabalho.

Este desenho mantém o `@basaltkit/queue` completamente fora do
`@basaltkit/tenancy`. O dispatch é da app, portanto qualquer agendador serve —
uma fila, um cron, um `basalt tenant:run` à mão.

### O estado, e porquê 503

| Estado | Serve pedidos | Como lá chega |
| --- | :---: | --- |
| *(nenhum)* | ✅ | Todos os tenants criados antes de existir provisionamento. **Tratados como prontos** — qualquer outra coisa poria uma frota em produção offline na atualização |
| `ready` | ✅ | O `onProvision` teve sucesso |
| `provisioning` | ❌ 503 | O `create()` escreveu o registo; o trabalho ainda não acabou |
| `failed` | ❌ 503 | O `onProvision` lançou. O registo é mantido, não apagado — é a evidência de que o tenant foi tentado |

**503, e não 404.** O tenant existe; apenas ainda não serve, e o 503 é o estado
que um cliente pode voltar a tentar. Um 404 diria o contrário.

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
correrem contra dados globais.

O `true` aplica-se a **todas** as rotas, o que a maioria das apps não aguenta: um
health check não tem tenant nenhum para enviar, e uma landing page ou um endpoint
público de preços também não. Isenta-os por caminho, em vez de abdicares da
proteção em todo o lado:

```ts
tenancyPlugin({
  source: tenants,
  resolvers: [headerResolver()],
  required: { except: ['/', '/health', '/openapi.json', /^\/public\//] },
})
```

As entradas são strings exatas ou expressões regulares, comparadas com o caminho
sem a query string — por isso `/health` cobre também `/health?probe=1`. Um URL
que não se consiga comparar é tratado como **obrigatório**, portanto a proteção
falha fechada.

### Separar rotas centrais de rotas de tenant

Uma lista de caminhos funciona, mas põe a decisão num ficheiro diferente da rota
que descreve: muda-se o URL e a exceção deixa de coincidir em silêncio. Declara
antes na própria rota, com `meta.tenant`:

```ts
// Rota central: nunca tem tenant.
route({ method: 'GET', url: '/pricing', meta: { tenant: false }, handler })

// Rota de tenant: recusa o pedido se nenhum for resolvido.
route({ method: 'GET', url: '/invoices', meta: { tenant: true }, handler })
```

O `meta.tenant` sobrepõe-se ao `required` da app nos dois sentidos, por isso a
combinação que a maioria das apps quer é **negar por omissão, abrir rota a
rota**:

```ts
tenancyPlugin({ source: tenants, resolvers: [headerResolver()], required: true })
```

Todas as rotas passam a precisar de tenant, e as poucas centrais — health check,
landing page, registo, criação de tenants — dizem-no ao lado do handler, onde
quem revê o código as vê. O `required: { except }` continua disponível e a
funcionar; usa-o para caminhos que não são teus, como rotas montadas por outro
pacote.

Uma rota com `meta: { tenant: false }` continua a *resolver* o tenant quando ele
existe, portanto o `ctx().tenant` está preenchido em
`acme.example.com/pricing`. O que se levanta é só a exigência.

Isentar um caminho levanta apenas a exigência de tenant. A autenticação, as
verificações de subscrição e todas as outras proteções continuam a correr.

Manter `required: false` continua válido quando as rotas centrais são mais do que
as de tenant, mas nesse caso cada handler fica responsável por tratar o tenant
ausente.

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

## Scoping fail-closed — a família `tenantScoped()`

As linhas da base de dados são o único sítio onde o isolamento é trabalho TEU: um
repositório que esqueça o filtro `tenantId` devolve as linhas de todos os tenants —
e com Prisma, `where: { tenantId: ctx().tenant?.id }` **descarta** silenciosamente o
filtro quando o tenant é `undefined`, transformando um bug numa fuga de dados entre
tenants que devolve `200 OK`. Os três helpers exportados por `@basaltkit/tenancy`
nunca fazem isso: quando não há nada a que dar âmbito, **lançam** em vez de
devolverem `undefined`.

| Helper | Assinatura | Devolve | Lança quando |
| --- | --- | --- | --- |
| `requireTenant()` | `() => Tenant` | O registo completo do tenant do contexto ativo | Não há tenant no contexto |
| `requireTenantId(fallback?)` | `(fallback?: string) => string` | O id do tenant do contexto; senão o `fallback` | Não há tenant no contexto **nem** `fallback` |
| `tenantScoped(where?)` | `<W>(where?: W) => W & { tenantId: string }` | A tua cláusula `where` com o `tenantId` fundido em **último** | Não há tenant a que dar âmbito |

Os três lançam `TenantRequiredError` (`400 TENANT_REQUIRED`).

```ts
import { requireTenant, requireTenantId, tenantScoped, TenantRequiredError } from '@basaltkit/tenancy'

// Uma query que nunca pode correr sem âmbito:
const rows = await db.project.findMany({ where: tenantScoped({ archived: false }) })
// → { archived: false, tenantId: 'acme' }

// O registo completo, quando precisas de mais do que o id:
const plan = requireTenant().plan

// Código de sistema (um job, um comando da CLI) pode fixar um tenant deliberadamente:
const tenantId = requireTenantId(job.tenantId)
```

Vale a pena enunciar exatamente três garantias, porque são o que torna a família
segura de usar sobre dados derivados de input:

- **O tenant do contexto ganha sempre.** O `tenantScoped()` espalha o `tenantId`
  em **último**, pelo que um `tenantId` infiltrado no `where` por input do cliente
  não consegue alargar nem trocar o âmbito: `tenantScoped({ tenantId: 'globex' })`
  dentro do contexto da Acme continua a dar `{ tenantId: 'acme' }`.
- **Um id explícito só é honrado quando não há tenant no contexto.** Esse é o
  caminho do código de sistema — um worker de fila ou um comando `basalt` a fixar
  um tenant. Dentro de um pedido nunca consegue sobrepor-se ao tenant resolvido.
- **Sem nenhum dos dois, lança.** O valor é sempre um id de tenant real, nunca um
  filtro que desaparece em silêncio. É esse o objetivo: um `400` é melhor do que
  uma leitura entre tenants.

::: tip A mesma forma noutros sítios
O `@basaltkit/activity` expõe a mesma ideia como opção de query:
`new Activity({ tenantScoped: 'required' })` faz as queries do seu trilho lançarem
em vez de devolverem silenciosamente as linhas de todos os tenants. Vários pacotes
trazem a sua própria variante fail-closed da verificação — `SEARCH_TENANT_REQUIRED`,
`FILE_TENANT_REQUIRED`, `COMMENT_TENANT_REQUIRED`, `AUDIT_TENANT_REQUIRED` — todas
com o mesmo significado: passa um `tenantId` ou corre dentro de um contexto de tenant.
:::

Estas verificações são **condicionais à tenancy estar registada**. O
`tenancyPlugin` define um marcador `tenancy:active` na metadata do container, e
cada package genérico lê-o para decidir se falha fechado: com tenancy ligada,
`SEARCH_TENANT_REQUIRED` / `FILE_TENANT_REQUIRED` / `COMMENT_TENANT_REQUIRED` /
`AUDIT_TENANT_REQUIRED` / `MissingCacheScopeError` aplicam-se; sem tenancy, não
existe dimensão de tenant e as mesmas chamadas funcionam sem âmbito. É a
[regra beyond-SaaS](/pt/guide/beyond-saas) — um package genérico nunca *exige*
tenancy. O `@basaltkit/cache` foi o primeiro a usar o marcador, trocando a
predefinição do seu `onMissingScope` de `'global'` para `'error'` em apps
multi-tenant; vê [Caching](/pt/guide/caching).

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

## Comandos da CLI

O `tenancyPlugin` regista cinco comandos no bucket da CLI, por isso aparecem assim
que o `@basaltkit/cli` está presente — sem ligação extra:

| Comando | Precisa de | O que faz |
| --- | --- | --- |
| `basalt tenant:list` | `source.list()` | Tabula todos os tenants (apenas campos escalares) |
| `basalt tenant:create <id> [--name=… --anyField=…]` | `source.create()` | Persiste um novo tenant; cada flag torna-se um campo |
| `basalt tenant:migrate [--tenant=<id>]` | `onMigrate` | Corre o teu hook de migração por tenant dentro do contexto de cada um |
| `basalt tenant:seed [--tenant=<id>]` | `onSeed` | Corre o teu hook de seed por tenant dentro do contexto de cada um |
| `onProvision` | `(tenant) => void \| Promise<void>` | — | Traz o storage de um tenant NOVO à existência, dentro do contexto dele, a partir do `tenancy.create()` e do `basalt tenant:create`. Sem isto o tenant é encaminhável antes de o schema existir |
| `provision` | `'inline' \| 'deferred'` | `'inline'` | `'inline'` — o `create()` espera, portanto o tenant está utilizável quando retorna. `'deferred'` — o `create()` retorna já, com estado `provisioning`, e o resolver responde 503 até correr o `tenancy.provision(id)` |
| `basalt tenant:run <id> <command> [args…]` | — | Corre qualquer outro comando registado dentro do contexto de um tenant |

O `onMigrate` / `onSeed` são onde vai o trabalho específico da base de dados — a
framework limita-se a iterar os tenants e a entrar em cada contexto:

```ts
tenancyPlugin({
  source: tenants,
  resolvers: [subdomainResolver({ base: 'basalt.app' })],
  onMigrate: async (tenant) => { await migrateSchemaFor(tenant.id) },
  onSeed: async (tenant) => { await ctx().db.plan.create({ data: { name: 'free' } }) },
})
```

Um hook em falta é reportado (`No migrate hook configured. …`) com código de saída 1
em vez de não fazer nada em silêncio; um `TenantSource` que não implementa
`list()` / `create()` é reportado da mesma forma.

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

## Referência de opções

`tenancyPlugin(options)`:

| Opção | Tipo | Predefinição | Propósito |
| --- | --- | --- | --- |
| `source` | `TenantSource` | — (obrigatório) | De onde são carregados os registos dos tenants — `MemoryTenantSource` em dev, `tenancy-sqlite`/`tenancy-prisma` (ou a tua própria tabela) em produção |
| `resolvers` | `TenantResolver[]` | — (obrigatório) | Tentados por ordem; vence a primeira referência que carrega um tenant existente, para poderes pôr um resolver de header atrás de um de subdomínio |
| `required` | `boolean \| { except: (string \| RegExp)[] }` | `false` | Rejeita um pedido que não resolveu nenhum tenant com `404 TENANCY_NOT_RESOLVED`, em vez de o correr sem tenant. `{ except }` isenta caminhos (health checks, landing pages) e continua a proteger o resto |
| `onMigrate` | `(tenant) => void \| Promise<void>` | — | Trabalho por tenant para o `basalt tenant:migrate`, corrido dentro do contexto de cada tenant |
| `onSeed` | `(tenant) => void \| Promise<void>` | — | Trabalho por tenant para o `basalt tenant:seed`, corrido dentro do contexto de cada tenant |

As fábricas de resolvers incorporadas:

| Fábrica | Opção | Tipo | Predefinição | Propósito |
| --- | --- | --- | --- | --- |
| `subdomainResolver({ base })` | `base` | `string` | — (obrigatório) | O domínio de topo sob o qual vivem os teus tenants. `acme.basalt.app` → `{ id: 'acme' }`; `www`, o domínio base nu e subdomínios aninhados (`a.b.basalt.app`) são ignorados |
| `domainResolver()` | — | — | — | O `Host` inteiro → `{ domain }`, resolvido através de `source.findByDomain`. Para domínios do cliente; exige esse método |
| `headerResolver({ header })` | `header` | `string` | `'x-tenant-id'` | Lê um header do pedido → `{ id: <value> }`. Muda-o quando o teu gateway já injeta outro header |
| `routeResolver({ param })` | `param` | `string` | `'tenant'` | Lê um parâmetro de rota → `{ id: params.tenant }`. Para tenancy por caminho (`/t/:tenant/…`) |

Cada fábrica devolve um `TenantResolver` simples — `(request) => TenantRef | null`
— por isso um resolver personalizado encaixa no mesmo array. O valor de `Host` é
canonicalizado (minúsculas, porta e pontos finais removidos, codificação IDNA) antes
da correspondência, pelo que `Victim.com:443`, `victim.com.` e um homógrafo unicode
dão todos a mesma chave.

`new CustomDomains(options)`:

| Opção | Tipo | Predefinição | Propósito |
| --- | --- | --- | --- |
| `store` | `DomainStore` | `new MemoryDomainStore()` | Onde vivem os domínios registados. Uma implementação durável **tem** de suportar o `add()` com uma restrição UNIQUE — esse insert é a barreira anti-roubo |
| `now` | `() => number` | `Date.now` | Relógio injetável (testes) |
| `token` | `() => string` | 24 bytes aleatórios, base64url | Gerador do token de verificação (testes) |
| `resolveTxt` | `(host) => Promise<string[][]>` | `resolveTxt` de `node:dns/promises` | Consulta DNS usada pelo `verify()`; substitui-a nos testes |

O `domains.verify(tenantId, domain, { force })` faz curto-circuito num domínio já
verificado a não ser que `force` esteja definido. Corre-o com `force: true` de forma
agendada: um domínio cujo DNS foi mais tarde removido ou reapontado é
**des**-verificado numa re-verificação falhada e deixa de resolver — a defesa contra
a tomada de domínios pendentes.

## Modos de falha & resolução de problemas

| Erro | Código | HTTP | Quando |
| --- | --- | --- | --- |
| `TenantRequiredError` | `TENANT_REQUIRED` | 400 | `tenantScoped()` / `requireTenantId()` / `requireTenant()` correram sem tenant no contexto e sem fallback explícito |
| `TenancyNotResolvedError` | `TENANCY_NOT_RESOLVED` | 404 | `required: true` e nenhum resolver produziu uma referência que carregasse um tenant |
| `TenantNotFoundError` | `TENANT_NOT_FOUND` | 500 | `tenancy.run('unknown-id', …)`, ou `forEach()` sobre um `TenantSource` sem `list()` |
| `TenantNotReadyError` | `TENANT_NOT_READY` | **503** | Um pedido resolveu para um tenant com estado `provisioning` ou `failed`. 503, e não 404: o tenant existe e o cliente pode voltar a tentar |
| `TenantCreateUnsupportedError` | `TENANT_CREATE_UNSUPPORTED` | 500 | `tenancy.create()` numa source que não implementa nem `create()` nem `save()` — por exemplo uma baseada num ficheiro de configuração estático |
| `DomainTakenError` | `DOMAIN_TAKEN` | 409 | `domains.add()` para um domínio que outro tenant já registou |
| `DomainNotFoundError` | `DOMAIN_NOT_FOUND` | 404 | `verify` / `instructions` / `remove` para um domínio que não está registado |
| `DomainForbiddenError` | `DOMAIN_FORBIDDEN` | 403 | Um tenant agiu sobre um domínio pertencente a um tenant **diferente** |
| `MissingCacheScopeError` | `CACHE_SCOPE_MISSING` | 500 | Uma leitura/escrita de cache correu sem tenant com a tenancy ativa — vê [Caching](/pt/guide/caching) |
| `NotATeamMemberError` | `TEAM_NOT_A_MEMBER` | 403 | O `tenantMembershipPlugin` não encontrou filiação do utilizador no tenant resolvido — vê [Teams](/pt/guide/teams) |

- **`TENANT_REQUIRED` num job em segundo plano ou num script** — não há resolver
  fora de um pedido. Envolve o trabalho em `tenancy.run(tenantId, …)`, ou passa o id
  explicitamente: `requireTenantId(job.tenantId)`.
- **`TENANT_REQUIRED` numa rota legitimamente central** (sign-up, landing page,
  administração da plataforma) — essas rotas não deviam sequer chamar
  `tenantScoped()`. Consulta a tabela sem âmbito deliberadamente, e mantém
  `required: false` no plugin.
- **`TENANCY_NOT_RESOLVED` embora o header/subdomínio pareça correto** — a
  referência resolveu mas o registo não carregou. Um id desconhecido cai
  *silenciosamente* para o resolver seguinte, por isso é quase sempre um tenant em
  falta na source (ou, com o `domainResolver`, um domínio que nunca foi
  **verificado**). Confirma com `basalt tenant:list`.
- **`403 TEAM_NOT_A_MEMBER` logo após trocar de tenant** — é o esperado, e é o
  objetivo: o tenant resolveu, a verificação de filiação recusou-o a seguir. A
  resolução de tenant é identificação, nunca autorização — vê [Teams](/pt/guide/teams).
- **Um domínio custom deixou de resolver sozinho** — uma re-verificação agendada
  `verify(…, { force: true })` falhou e des-verificou-o. Volta a publicar o registo
  TXT `_basalt-verify.<domain>`.

## Eventos

| Hook | Payload |
| --- | --- |
| `tenancy:switched` | `{ tenant }` — emitido em cada entrada num contexto de tenant, pelo enricher HTTP e pelo `tenancy.run()` |

Os registos duráveis de tenants e as opções de base de dados por tenant estão em
[Persistência](/pt/guide/persistence); o fluxo de sign-up ponta a ponta está no
[cookbook de SaaS multi-tenant](/pt/cookbook/multi-tenant-saas) e em
[Criar um tenant](/pt/guide/creating-a-tenant).
