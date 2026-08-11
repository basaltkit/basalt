# Teams

`@basaltkit/teams` transforma um tenant numa **equipa multi-utilizador**: membros com
roles hierarquizados, e convites por email para aderir. É desacoplado da autenticação e
da tenancy — os identificadores são lidos do contexto do pedido — e pode espelhar as
alterações de role para [`@basaltkit/permissions`](/guide/security).

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

::: tip Dica
Com âmbito de tenant. Tudo está isolado por tenant: memberships, convites e o guard
`teamRole` chaveiam-se todos em `ctx().tenant.id`. Um utilizador pode ser `owner` de uma
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

Uma equipa mantém sempre pelo menos um owner — o serviço recusa-se a despromover ou
remover o último (`LastOwnerError`, `TEAM_LAST_OWNER`). Promove outra pessoa primeiro.

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
| `POST /team/invites/accept` `{ token }` | login |
| `GET /team/invites` · `DELETE /team/invites/:id` | `admin` |
| `GET /team/members` | `member` |
| `PATCH /team/members/:userId` `{ role }` | `admin` |
| `DELETE /team/members/:userId` | `admin` |

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
deixassem a equipa sem um owner.

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

## Códigos de erro

| Erro | Código | HTTP |
| --- | --- | --- |
| `TeamInviteInvalidError` | `TEAM_INVITE_INVALID` | 400 |
| `NotATeamMemberError` | `TEAM_NOT_A_MEMBER` | 403 |
| `InsufficientTeamRoleError` | `TEAM_ROLE_REQUIRED` | 403 |
| `LastOwnerError` | `TEAM_LAST_OWNER` | 400 |

## Eventos

| Hook | Payload |
| --- | --- |
| `team:invited` | `{ invitation, token }` — envia o email aqui |
| `team:joined` | `{ membership }` |
| `team:role_changed` | `{ membership }` |
| `team:member_removed` | `{ tenantId, userId }` |

O fluxo completo — incluindo o encanamento de email — está no
[cookbook do ciclo de vida da conta](/cookbook/account-lifecycle).
