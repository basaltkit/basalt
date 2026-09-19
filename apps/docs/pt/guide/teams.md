# Teams

`@basaltkit/teams` transforma um tenant numa **equipa multi-utilizador**: membros com
roles hierarquizados, e convites por email para aderir. É desacoplado da autenticação e
da tenancy — os identificadores são lidos do contexto do pedido — e pode espelhar as
alterações de role para [`@basaltkit/permissions`](/pt/guide/security).

[[toc]]

## Configuração

Teams lê o tenant atual de `ctx().tenant` (definido pela tenancy) e o utilizador
ativo de `ctx().user` (definido pela autenticação), por isso regista os três. Esta é a
ligação completa, incluindo o seeding do primeiro owner e a transformação do hook de
convite num email:

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify'
import { authPlugin, authRoutes, MemoryUserSource } from '@basaltkit/auth'
import { tenancyPlugin, headerResolver, MemoryTenantSource } from '@basaltkit/tenancy'
import { teamsPlugin, teamRoutes, TEAMS } from '@basaltkit/teams'

const app = await createApp({
  plugins: [
    tenancyPlugin({
      source: new MemoryTenantSource().add({ id: 'acme' }),
      resolvers: [headerResolver()], // lê x-tenant-id em dev
    }),
    authPlugin({ users: new MemoryUserSource(), secret: process.env.AUTH_SECRET! }),
    teamsPlugin(),
    fastifyPlugin({ routes: [...authRoutes(), ...teamRoutes()] }),
  ],
}).boot()

// Envia o email de convite quando um é criado (ver Convites abaixo)
app.hooks.on('team:invited', ({ invitation, token }) =>
  mailer.send(invitation.email, `https://app.example.com/invite?token=${token}`))

// Faz o seed do primeiro owner quando o tenant é criado — os convites são para os restantes
await app.container.get(TEAMS).addMember('acme', 'ada-id', 'owner')
```

Os pedidos passam então a transportar `Authorization: Bearer <login token>` e um
identificador de tenant (`x-tenant-id: acme` com `headerResolver`, ou um subdomínio em
produção).

::: tip Com âmbito de tenant
Tudo está isolado por tenant: memberships, convites e o guard `teamRole`
chaveiam-se todos em `ctx().tenant.id`. Um utilizador pode ser `owner` de uma
equipa e `member` de outra.
:::

## Stores duráveis (produção)

Os stores `Memory*` por padrão esquecem tudo ao reiniciar. Troca-os por um backend
durável e os rosters e convites pendentes sobrevivem a um redeploy.

### SQLite — `@basaltkit/teams-sqlite`

Zero dependências externas, construído sobre `node:sqlite` (Node 22.5+):

```ts
import { teamsPlugin } from '@basaltkit/teams'
import { sqliteTeamsStores } from '@basaltkit/teams-sqlite'

const t = sqliteTeamsStores('./data/teams.db') // ':memory:' por padrão; abre + migra
teamsPlugin({ memberships: t.memberships, invitations: t.invitations })
```

### Prisma — `@basaltkit/teams-prisma`

Para PostgreSQL/MySQL. Copia os modelos `TeamMembership` / `TeamInvitation` de
`@basaltkit/teams-prisma/schema.prisma`, corre `prisma migrate dev && prisma generate` e depois:

```ts
import { teamsPlugin } from '@basaltkit/teams'
import { prismaTeamsStores } from '@basaltkit/teams-prisma'
import { PrismaClient } from '@prisma/client'

const t = prismaTeamsStores(new PrismaClient())
teamsPlugin({ memberships: t.memberships, invitations: t.invitations })
```

Os stores individuais (`SqliteMembershipStore`, `PrismaMembershipStore`, …) também são
exportados, e recebem um `DatabaseSync` / `PrismaClient` no seu construtor.

## Roles

Os roles são uma hierarquia com ranking — o mais alto sobrepõe-se ao mais baixo, portanto
uma rota que requer `admin` também aceita `owner`:

| Role | Rank |
| --- | --- |
| `owner` | 3 |
| `admin` | 2 |
| `member` | 1 |

Os roles são strings livres; sobrepõe a hierarquia com um mapa nome → rank (roles
fora do mapa têm rank 0):

```ts
teamsPlugin({ roleRank: { owner: 4, admin: 3, editor: 2, viewer: 1 } })
```

Um membro que atua através das rotas só pode conceder roles que **estão no
mapa**. Um role sem rank (por exemplo um role de permissão `billing-admin`
espelhado via `access`) é recusado com `TeamRoleNotGrantableError`
(`403 TEAM_ROLE_NOT_GRANTABLE`), para que uma string `role` livre não sirva para
o conceder. Para permitir que os membros concedam um role extra sem rank,
lista-o explicitamente:

```ts
teamsPlugin({ grantableRoles: ['viewer'] })
```

Uma equipa mantém sempre pelo menos um owner — o serviço recusa-se a despromover ou
remover o último (`LastOwnerError`, `TEAM_LAST_OWNER`). Promove outra pessoa primeiro.

::: tip Sem escalada de privilégios via convites ou mudanças de role
As rotas HTTP passam o utilizador ativo ao serviço (`actingUserId`), que então
impõe duas regras: o ator nunca pode conceder um role **acima do seu próprio
rank** (um `admin` não pode convidar nem promover ninguém — incluindo a si
próprio — a `owner`), e nunca pode alterar o role nem despromover um membro que
atualmente o **supere em rank**. As violações lançam
`InsufficientTeamRoleError` (`403 TEAM_ROLE_REQUIRED`). O mesmo se aplica à
remoção: `DELETE /team/members/:userId` só pode remover o próprio ator ou um
membro que não o supere em rank, por isso um `admin` não pode remover um
`owner`. Roles ausentes de `roleRank` não podem ser concedidos (ver acima).
Chamadas ao serviço sem `actingUserId` (seeding server-side de confiança)
saltam a verificação.
:::

## Seeding do primeiro owner

Os convites inscrevem membros, mas o primeiro owner é semeado diretamente — tipicamente
quando o tenant é criado:

```ts
import { TEAMS } from '@basaltkit/teams'
await app.container.get(TEAMS).addMember(tenant.id, creator.id, 'owner')
```

## Rotas

`teamRoutes()` regista, tudo com âmbito no tenant atual (sem tenant no contexto
→ `400 TEAM_NO_TENANT`):

| Endpoint | Requer |
| --- | --- |
| `POST /team/invites` `{ email, role? }` | `admin` |
| `POST /team/invites/accept` `{ token }` | login com email **verificado** |
| `GET /team/invites` · `DELETE /team/invites/:id` | `admin` |
| `GET /team/members` | `member` |
| `PATCH /team/members/:userId` `{ role }` | `admin` |
| `DELETE /team/members/:userId` | `admin` |

`teamRoutes(options)` aceita `requireVerifiedEmail` (predefinição `true`),
descrito na secção de convites abaixo.

## Role guard

`teamsPlugin` regista o guard `teamRole`: o utilizador atual tem de ter o
role requerido — ou um de rank superior — no tenant atual. Utilizador **ou** tenant em
falta no contexto → `403 TEAM_NOT_A_MEMBER`; role insuficiente →
`403 TEAM_ROLE_REQUIRED`:

```ts
import { route } from '@basaltkit/fastify'

route({
  method: 'POST',
  url: '/projects',
  meta: { auth: true, teamRole: 'admin' }, // member → 403 TEAM_ROLE_REQUIRED
  async handler() { return { created: true } },
})
```

`teamsPlugin` reclama a chave `teamRole` na verificação de meta-guardada feita
pelos adaptadores no arranque — declarar `meta.teamRole` numa rota **sem**
registar o plugin recusa arrancar com `UnguardedRouteMetaError`
(`HTTP_UNGUARDED_ROUTE_META`) em vez de servir silenciosamente a rota sem guard.
O mesmo mecanismo cobre `meta.auth` e `meta.can` — vê a
[tabela de guards/meta no guia de autorização](/pt/guide/authorization#modelo-mental)
e o [guia de adaptadores](/pt/guide/adapters).

## Guard de isolamento de tenant (`tenantMembershipPlugin`)

`meta.teamRole` protege as rotas que te lembraste de anotar.
`tenantMembershipPlugin` fecha a lacuna restante **em toda a aplicação**: em
*cada* pedido que tenha simultaneamente um utilizador autenticado e um tenant
resolvido, afirma que o utilizador detém mesmo um membership nesse tenant — para
que um utilizador válido do tenant A nunca possa operar sobre o tenant B só por
enviar `x-tenant-id: b` ou o cabeçalho `Host` certo. A *resolução* de tenant é
identificação, nunca autorização.

```ts
import { teamsPlugin, tenantMembershipPlugin } from '@basaltkit/teams'

createApp({
  plugins: [
    authPlugin(/* … */),
    tenancyPlugin(/* … */),
    teamsPlugin(/* … */),
    tenantMembershipPlugin(), // membership imposto em todo o lado, por predefinição
  ],
})
```

Um não-membro recebe `403 TEAM_NOT_A_MEMBER`. O guard é saltado quando o pedido
não tem tenant resolvido nem utilizador (tráfego central/anónimo), para
**rotas de conta** (`meta: { account: true }`) e para rotas que optam
explicitamente por sair com `meta: { central: true }` — criação de tenant,
administração da plataforma: rotas que legitimamente atuam através de vários
tenants ou fora de um único tenant.

As rotas de conta dizem respeito à identidade de quem chama, não aos dados do
tenant: `authRoutes()`, `mfaRoutes()` e `oauthRoutes()` (`@basaltkit/auth`) e
`POST /team/invites/accept` declaram `account: true`, por isso um utilizador
autenticado que (ainda) não é membro consegue entrar, ler `/auth/me` e aceitar
um convite no subdomínio da empresa, enquanto todas as outras rotas do tenant
continuam só para membros. `apiKeyRoutes()` **não** é rota de conta — as
chaves estão ligadas a um tenant. Marca as tuas rotas de perfil com
`account: true` da mesma forma.

Três comportamentos a conhecer:

- **Existência, não rank, por predefinição.** O guard pergunta "existe um
  registo de membership?", não "o role supera `member` em rank?" — por isso um
  membro genuíno com um role personalizado ausente de `roleRank` (rank 0) não é
  rejeitado. Passa `role: 'member'` (ou superior) para mudar para semântica de
  rank.
- **`exempt` é a válvula de escape baseada em QUEM.** Para identidades que
  legitimamente cruzam tenants (administradores da plataforma, impersonação de
  suporte), dá um predicado sobre o contexto do pedido:
  `exempt: ({ user }) => user?.platformAdmin === true`. Prefere-o a
  `meta.central` quando a exceção é sobre *quem está a chamar* — `central`
  desativa o guard para **toda a gente** nessa rota. Os resultados de exceção
  **nunca são cacheados**.
- **A cache de decisões é opt-in.** Sem ela, cada pedido protegido custa uma
  consulta de membership (uma única leitura indexada por PK — normalmente
  aceitável). Com `cache: { ttlMs, maxEntries }`, as decisões são cacheadas
  em processo e descartadas **imediatamente** pelos hooks `team:joined` /
  `team:role_changed` / `team:member_removed` — mudanças no mesmo processo são
  sempre exatas. `ttlMs` apenas limita a desatualização de mudanças feitas
  *noutra réplica*: um membro removido noutro sítio pode manter acesso até
  `ttlMs`. O mapa é limitado em tamanho por `maxEntries` (predefinição 10 000,
  os mais antigos são despejados).

```ts
tenantMembershipPlugin({
  role: 'member',                      // opcional: semântica de rank em vez de existência
  exempt: ({ user }) => (user as { platformAdmin?: boolean })?.platformAdmin === true,
  cache: { ttlMs: 30_000, maxEntries: 10_000 },
})
```

::: tip Combina-o com billing
`billingRoutes()` / `invoiceRoutes()` autenticam o *utilizador* mas resolvem o
*billable* a partir do tenant — com este guard registado, um utilizador do
tenant A que chame checkout/portal/invoices com o identificador do tenant B é
travado com `403 TEAM_NOT_A_MEMBER` antes de qualquer código de billing correr.
Vê [Billing](/pt/guide/billing) e o [guia de segurança](/pt/guide/security).
:::

## Convites (invite → accept)

`POST /team/invites` cunha um token de uso único e expirável (padrão 7 dias) e emite
`team:invited` que o transporta. **O token é enviado por email — nunca devolvido por HTTP.**
Um novo convite para o mesmo endereço substitui qualquer um pendente (um convite pendente
por email por equipa). Por HTTP:

```bash
# 1. Um admin convida o Bob (201; a resposta nunca contém o token)
curl -X POST http://localhost:3000/team/invites \
  -H 'authorization: Bearer <admin token>' -H 'x-tenant-id: acme' \
  -H 'content-type: application/json' \
  -d '{"email":"bob@example.com","role":"member"}'

# 2. O Bob segue o link enviado por email, autentica-se e depois aceita com o token
curl -X POST http://localhost:3000/team/invites/accept \
  -H 'authorization: Bearer <bob token>' -H 'x-tenant-id: acme' \
  -H 'content-type: application/json' -d '{"token":"<token-from-email>"}'
```

O mesmo fluxo com o serviço `Teams` (alcançado via o token `TEAMS`):

```ts
import { TEAMS } from '@basaltkit/teams'
const teams = app.container.get(TEAMS)

const { invitation, token } = await teams.invite({
  tenantId: 'acme', email: 'bob@example.com', role: 'member', invitedBy: 'ada-id',
})
// invitation é PublicInvitation (sem token); o token vai no link do email
const membership = await teams.accept(token, 'bob-id')
// → { tenantId: 'acme', userId: 'bob-id', role: 'member', createdAt }
```

Estas propriedades de segurança estão incorporadas:

- **Os tokens são guardados em hash.** Só o SHA-256 do token é persistido — uma
  fuga da tabela de convites não pode ser reproduzida para aderir a uma equipa;
  o token em bruto vive apenas no link enviado por email.
- **A aceitação está vinculada ao endereço convidado.** A rota de aceitação
  passa o email de quem chama (`ctx().user.email`) como `acceptingEmail`; um
  link reencaminhado ou fugido resgatado por uma conta *diferente* falha com o
  mesmo `TEAM_INVITE_INVALID` que um token forjado — um destinatário errado não
  consegue distinguir um token real de um falso. Em código, passa o email
  **verificado** de quem chama; omite-o apenas em fluxos server-side de
  confiança. Quem chama sem email em `ctx().user` é recusado
  (`TEAM_INVITE_INVALID`) e nunca é inscrito sem vínculo.
- **O endereço tem de estar verificado.** Por predefinição, a rota de aceitação
  também exige `ctx().user.emailVerified === true` e, caso contrário, responde
  `403 TEAM_EMAIL_NOT_VERIFIED`. Sem isso, qualquer pessoa que registe o
  endereço do convidado poderia resgatar um link fugido. Só apps que provam a
  posse do endereço de outra forma devem desativar com
  `teamRoutes({ requireVerifiedEmail: false })`. O vínculo ao endereço
  continua a aplicar-se.
- **Uso único, mesmo com concorrência.** Os stores aceitam um convite com um
  compare-and-set (`markAccepted` resolve `false` se o convite já não estiver
  pendente), por isso um token inscreve no máximo uma conta. Um
  `InvitationStore` personalizado deve fazer o mesmo. Devolver `void` continua
  a ser aceite, mas perdes essa garantia.

Um token desconhecido, usado, revogado ou expirado lança `TeamInviteInvalidError`
(`400 TEAM_INVITE_INVALID`). Liga o hook de email uma vez no arranque:

```ts
app.hooks.on('team:invited', ({ invitation, token }) =>
  mailer.send(InviteEmail, { url: `${APP_URL}/invite?token=${token}` }, { to: invitation.email }))
```

## Listar membros e convites

```ts
const teams = app.container.get(TEAMS)

await teams.members('acme')          // Membership[] — GET /team/members
await teams.pendingInvites('acme')   // PublicInvitation[] — GET /team/invites
await teams.roleOf('acme', 'bob-id') // 'member' | null
await teams.can('acme', 'bob-id', 'admin') // false — member (1) < admin (2)
await teams.changeRole('acme', 'bob-id', 'admin') // PATCH /team/members/:userId
await teams.removeMember('acme', 'bob-id')        // DELETE /team/members/:userId
await teams.revokeInvite(invitationId)            // DELETE /team/invites/:id
```

`changeRole` e `removeMember` lançam `LastOwnerError` (`400 TEAM_LAST_OWNER`) se
deixassem a equipa sem um owner. A regra é verificada de novo depois da escrita,
e a escrita é revertida se perdeu uma corrida. Isto impede que duas
despromoções/remoções concorrentes deixem a equipa com zero owners. Passa
`{ actingUserId }` a `changeRole`/`removeMember`/`addMember` para aplicar as
regras de rank a uma chamada iniciada por um utilizador, como fazem as rotas.

## Espelhar roles para permissions

Passa um store `access` (um `AccessStore` de `@basaltkit/permissions` satisfaz o
`RoleAssigner` estrutural) e cada alteração de membership torna-se uma concessão de role
no âmbito desse tenant:

```ts
import { MemoryAccessStore } from '@basaltkit/permissions'
const access = new MemoryAccessStore()
teamsPlugin({ access })
// teams.addMember('acme', 'u1', 'admin') → access.assignRole('u1', 'admin', 'acme')
```

O role é detido **no tenant**, por isso as suas permissões têm de se resolver
lá também. Define uma vez o que `owner`/`admin`/`member` podem fazer com
`permissionsPlugin({ roleCatalog })` (ou `inheritGlobalRolePermissions`) em vez
de conceder o catálogo em cada tenant — vê
[Um catálogo de roles para todos os tenants](/pt/guide/authorization#um-catalogo-de-roles-para-todos-os-tenants).

## Referência de opções

`teamsPlugin(options)`:

| Opção | Tipo | Predefinição | Propósito |
| --- | --- | --- | --- |
| `memberships` | `MembershipStore` | em memória | Onde vivem os memberships — troca por `teams-sqlite`/`teams-prisma` em produção |
| `invitations` | `InvitationStore` | em memória | Onde vivem os convites (tokens em hash) |
| `access` | `RoleAssigner` | — | Espelha cada mudança de membership numa concessão de role de `@basaltkit/permissions` no âmbito do tenant |
| `inviteTtl` | `DurationInput` | `'7d'` | Tempo de vida do link de convite |
| `roleRank` | `Record<string, number>` | `{ owner: 3, admin: 2, member: 1 }` | Hierarquia de roles; roles fora do mapa têm rank 0 |
| `grantableRoles` | `TeamRole[]` | `[]` | Roles sem rank que um utilizador ativo pode ainda conceder; qualquer outro role fora de `roleRank` é recusado (`TEAM_ROLE_NOT_GRANTABLE`) |
| `now` | `() => number` | `Date.now` | Relógio injetável (testes) |

`tenantMembershipPlugin(options)`:

| Opção | Tipo | Predefinição | Propósito |
| --- | --- | --- | --- |
| `role` | `TeamRole` | — (verificação de existência) | Exigir um role mínimo com *rank* em vez de qualquer registo de membership |
| `exempt` | `(context) => boolean` | — | Escape baseado em QUEM para identidades entre tenants (admin de plataforma, suporte); nunca cacheado |
| `cache` | `{ ttlMs: number; maxEntries?: number }` | desligado | Cache de decisões em processo, opt-in; invalidada por hooks no mesmo processo (uma consulta que coincide com uma invalidação não é cacheada), `ttlMs` limita a desatualização entre réplicas, `maxEntries` predefinição 10 000 |

`teamRoutes(options)`:

| Opção | Tipo | Predefinição | Propósito |
| --- | --- | --- | --- |
| `requireVerifiedEmail` | `boolean` | `true` | Exigir `ctx().user.emailVerified === true` para aceitar um convite |

## Modos de falha e troubleshooting

| Erro | Código | HTTP | Quando |
| --- | --- | --- | --- |
| `TeamInviteInvalidError` | `TEAM_INVITE_INVALID` | 400 | Token desconhecido, usado, revogado, expirado — ou resgatado por uma conta cujo email não é o convidado |
| `NotATeamMemberError` | `TEAM_NOT_A_MEMBER` | 403 | `tenantMembershipPlugin` não encontrou membership; ou uma rota com `meta.teamRole` correu sem utilizador **ou** sem tenant no contexto |
| `InsufficientTeamRoleError` | `TEAM_ROLE_REQUIRED` | 403 | Rank do role abaixo do exigido, incluindo um ator a tentar conceder, despromover ou remover acima do seu próprio rank |
| `TeamRoleNotGrantableError` | `TEAM_ROLE_NOT_GRANTABLE` | 403 | Um utilizador ativo tentou conceder um role que não está em `roleRank` nem em `grantableRoles` |
| `TeamEmailNotVerifiedError` | `TEAM_EMAIL_NOT_VERIFIED` | 403 | `POST /team/invites/accept` por um utilizador cujo email não está verificado (ver `requireVerifiedEmail`) |
| `LastOwnerError` | `TEAM_LAST_OWNER` | 400 | A mudança deixaria a equipa sem owner |
| `TEAM_NO_TENANT` | `TEAM_NO_TENANT` | 400 | Um endpoint de `teamRoutes()` foi chamado sem tenant no contexto — regista a tenancy e envia o identificador do tenant |
| `TEAM_INVITE_NOT_FOUND` | `TEAM_INVITE_NOT_FOUND` | 404 | `DELETE /team/invites/:id` para um id que não existe ou pertence a outro tenant |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | arranque | Uma rota declara `meta.teamRole` e `teamsPlugin` não está registado |

- **`TEAM_NOT_A_MEMBER` logo após adicionar um membro noutra réplica** — o
  `ttlMs` da cache de membership limita a desatualização entre réplicas em ambos
  os sentidos; a decisão é refrescada dentro de `ttlMs`.
- **Um role personalizado continua a receber `TEAM_ROLE_REQUIRED`** — roles fora
  de `roleRank` têm rank 0. Adiciona o role ao mapa, ou (para o guard de
  membership) confia na semântica de existência predefinida em vez de `role:`.
- **`403` numa rota central (login, registo, criação de tenant)** — marca-a com
  `meta: { central: true }`, ou isenta a identidade que chama com `exempt`.

## Eventos

| Hook | Payload |
| --- | --- |
| `team:invited` | `{ invitation, token }` — envia o email aqui |
| `team:joined` | `{ membership }` |
| `team:role_changed` | `{ membership }` |
| `team:member_removed` | `{ tenantId, userId }` |

O fluxo completo — incluindo o encanamento de email — está no
[cookbook do ciclo de vida da conta](/pt/cookbook/account-lifecycle).
