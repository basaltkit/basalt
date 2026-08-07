# @machize/teams

Equipas para aplicações Machize: torna cada tenant multi-utilizador, com papéis hierárquicos (owner/admin/member), convites por email com aceitação e revogação, gestão de membros e um guard de rotas por papel de equipa.

Precisas deste módulo quando várias pessoas partilham a mesma conta/organização — "convidar um colega para o workspace" é exatamente isto.

## O que este módulo resolve

Num SaaS, uma organização (tenant) raramente tem um só utilizador: a fundadora convida colegas, alguns são administradores e outros só membros. Este módulo gere essas **pertenças** (memberships) — quem pertence a que equipa e com que **papel** (role: o nome do "cargo" da pessoa na equipa, como `owner`, `admin` ou `member`) — e os **convites**: a pessoa recebe por email um link com um **token** (código secreto de utilização única) e, ao aceitar, entra na equipa com o papel definido no convite.

Os papéis são hierárquicos por rank: por omissão `owner` (3) > `admin` (2) > `member` (1). Quem tem um papel de rank superior pode fazer tudo o que o inferior faz — uma rota que exige `admin` também aceita `owner`. Há proteções embutidas: uma equipa nunca pode ficar sem owner (o último não pode ser removido nem despromovido), os tokens de convite expiram (7 dias por omissão), são de utilização única e nunca aparecem nas respostas HTTP — só no hook `team:invited`, para a tua aplicação enviar por email.

O módulo é deliberadamente desacoplado: recebe `tenantId` e `userId` como strings, por isso funciona com qualquer autenticação e tenancy. Opcionalmente espelha os papéis de equipa no `@machize/permissions`, para que "admin da equipa acme" se traduza automaticamente em permissões.

## Instalação

```bash
pnpm add @machize/teams
```

## Começar em 5 minutos

1. **Só a lógica (sem HTTP)** — cria a equipa, convida e aceita:

```ts
import { Teams } from '@machize/teams'

const teams = new Teams() // stores em memória por omissão

// A primeira owner é adicionada diretamente (ex.: ao criar o tenant)
await teams.addMember('acme', 'user-ada', 'owner')

// Convida o Bob como member — o token vai no link do email
const { invitation, token } = await teams.invite({
  tenantId: 'acme',
  email: 'bob@exemplo.com',
  role: 'member',
  invitedBy: 'user-ada',
})

// O Bob (já autenticado como user-bob) aceita com o token do link
const membership = await teams.accept(token, 'user-bob')
console.log(membership) // { tenantId: 'acme', userId: 'user-bob', role: 'member', createdAt: ... }

console.log(await teams.roleOf('acme', 'user-bob')) // 'member'
console.log(await teams.can('acme', 'user-bob', 'admin')) // false — member < admin
```

2. **Aplicação HTTP completa** com auth + tenancy + rotas de equipa prontas:

```ts
import { createApp } from '@machize/core'
import { fastifyPlugin } from '@machize/fastify'
import { authPlugin, authRoutes, MemoryUserSource } from '@machize/auth'
import { tenancyPlugin, headerResolver, MemoryTenantSource } from '@machize/tenancy'
import { teamsPlugin, teamRoutes, TEAMS } from '@machize/teams'

const app = await createApp({
  plugins: [
    tenancyPlugin({
      source: new MemoryTenantSource().add({ id: 'acme' }),
      resolvers: [headerResolver()],
    }),
    authPlugin({ users: new MemoryUserSource(), secret: process.env.AUTH_SECRET! }),
    teamsPlugin(),
    fastifyPlugin({ routes: [...authRoutes(), ...teamRoutes()] }),
  ],
}).boot()

// Envia o email do convite quando ele é criado
app.hooks.on('team:invited', async ({ invitation, token }) => {
  await enviarEmail(invitation.email, `https://app.exemplo.com/convite?token=${token}`)
})

// Semeia a primeira owner ao criar a organização
const teams = app.container.get(TEAMS)
await teams.addMember('acme', 'id-da-ada', 'owner')
```

3. A partir daqui, os pedidos HTTP (com `Authorization: Bearer <token do login>` e `x-tenant-id: acme`) usam as rotas prontas: `POST /team/invites`, `POST /team/invites/accept`, `GET /team/members`, etc.

## Guia de utilização

### Convites

- `invite({ tenantId, email, role?, invitedBy? })` cria (ou substitui) o convite — **um convite pendente por email por equipa**; um novo revoga o anterior. Papel por omissão: `'member'`. Validade: `inviteTtl` (default `'7d'`).
- Devolve `{ invitation, token }` — `invitation` é `PublicInvitation` (sem o token) e o `token` serve para construir o link. O hook `team:invited` recebe o mesmo par.
- `accept(token, userId)` consome o token (única utilização) e inscreve o utilizador com o papel do convite. Token desconhecido, usado, revogado ou expirado → `TeamInviteInvalidError` (400).
- `pendingInvites(tenantId)` lista os pendentes não expirados; `revokeInvite(id)` cancela; `invitation(id)` consulta um.

### Membros e papéis

```ts
import { Teams } from '@machize/teams'

const teams = new Teams()
await teams.addMember('acme', 'u1', 'owner')

await teams.members('acme')                 // lista de Membership
await teams.roleOf('acme', 'u1')            // 'owner' (ou null se não for membro)
await teams.can('acme', 'u1', 'admin')      // true — owner (3) >= admin (2)
await teams.changeRole('acme', 'u2', 'admin')
await teams.removeMember('acme', 'u2')
```

Proteção do último owner: `changeRole` e `removeMember` lançam `LastOwnerError` (400) se deixassem a equipa sem nenhum `owner`.

### Hierarquia de papéis personalizada

Os papéis são strings livres; a hierarquia é um mapa nome → rank (papéis fora do mapa têm rank 0):

```ts
import { Teams } from '@machize/teams'

const teams = new Teams({
  roleRank: { owner: 4, admin: 3, editor: 2, viewer: 1 },
})
```

### Proteger rotas por papel (`meta.teamRole`)

O `teamsPlugin` regista um guard: rotas com `meta: { teamRole: 'admin' }` exigem que o utilizador atual (`ctx().user`, do auth) tenha esse papel **ou superior** no tenant atual (`ctx().tenant`, da tenancy):

```ts
import { route } from '@machize/fastify'

const rota = route({
  method: 'POST',
  url: '/projetos',
  meta: { auth: true, teamRole: 'admin' }, // member → 403 TEAM_ROLE_REQUIRED
  async handler() { return { criado: true } },
})
```

Sem tenant ou sem utilizador no contexto → `NotATeamMemberError` (403).

### Espelhar papéis no @machize/permissions

Passa um `RoleAssigner` (qualquer objeto com `assignRole`/`removeRole` — um `AccessStore` do permissions serve) e cada entrada/mudança/saída de equipa é espelhada como papel no scope do tenant:

```ts
import { Teams } from '@machize/teams'
import { MemoryAccessStore } from '@machize/permissions'

const access = new MemoryAccessStore()
const teams = new Teams({ access })

await teams.addMember('acme', 'u1', 'admin')
// → access.assignRole('u1', 'admin', 'acme') foi chamado automaticamente
```

### Hooks (eventos)

| Hook | Payload | Quando |
|---|---|---|
| `team:invited` | `{ invitation, token }` | Convite criado — envia o email aqui. |
| `team:joined` | `{ membership }` | Alguém entrou (accept ou addMember). |
| `team:role_changed` | `{ membership }` | Papel alterado. |
| `team:member_removed` | `{ tenantId, userId }` | Membro removido. |

## Referência da API

### `teamsPlugin(options)` e classe `Teams`

Opções (`TeamsOptions`; `TeamsPluginOptions` é o mesmo sem `hooks`) — todas opcionais:

| Nome | Tipo | Default | Descrição |
|---|---|---|---|
| `memberships` | `MembershipStore` | `MemoryMembershipStore` | Onde vivem as pertenças. |
| `invitations` | `InvitationStore` | `MemoryInvitationStore` | Onde vivem os convites. |
| `access` | `RoleAssigner` | — | Espelha papéis (ex.: AccessStore do permissions). |
| `inviteTtl` | `DurationInput` | `'7d'` | Validade do link de convite. |
| `roleRank` | `Record<string, number>` | `{ owner: 3, admin: 2, member: 1 }` | Hierarquia de papéis. |
| `now` | `() => number` | `Date.now` | Relógio injetável (testes). |
| `hooks` | `HookBus` | — | Só na classe; o plugin injeta-o. |

Métodos de `Teams`:

| Método | Devolve | Descrição |
|---|---|---|
| `addMember(tenantId, userId, role)` | `Promise<Membership>` | Adiciona/atualiza diretamente (seed do primeiro owner). |
| `invite(input)` | `Promise<{ invitation, token }>` | Cria/substitui o convite; emite `team:invited`. |
| `accept(token, userId)` | `Promise<Membership>` | Consome o token e inscreve o utilizador. |
| `members(tenantId)` | `Promise<Membership[]>` | Lista os membros. |
| `pendingInvites(tenantId)` | `Promise<PublicInvitation[]>` | Convites pendentes não expirados. |
| `invitation(id)` | `Promise<PublicInvitation \| null>` | Um convite (sem token). |
| `revokeInvite(id)` | `Promise<void>` | Cancela um convite pendente. |
| `roleOf(tenantId, userId)` | `Promise<TeamRole \| null>` | Papel do utilizador (ou null). |
| `can(tenantId, userId, required)` | `Promise<boolean>` | Tem o papel exigido ou superior? |
| `changeRole(tenantId, userId, role)` | `Promise<Membership>` | Muda o papel; protege o último owner. |
| `removeMember(tenantId, userId)` | `Promise<void>` | Remove; protege o último owner. |
| `rankOf(role)` | `number` | Rank do papel (0 se desconhecido). |

### Rotas prontas — `teamRoutes()`

Todas exigem login (`meta.auth`); as marcadas exigem também papel na equipa. O tenant vem de `ctx().tenant` (sem ele → 400 `TEAM_NO_TENANT`).

| Rota | Papel mínimo | Descrição |
|---|---|---|
| `POST /team/invites` `{ email, role? }` | admin | Cria o convite (201; o token nunca vem na resposta). |
| `POST /team/invites/accept` `{ token }` | (só login) | Aceita o convite. |
| `GET /team/invites` | admin | Lista convites pendentes. |
| `DELETE /team/invites/:id` | admin | Revoga (404 se de outro tenant). |
| `GET /team/members` | member | Lista membros. |
| `PATCH /team/members/:userId` `{ role }` | admin | Muda o papel. |
| `DELETE /team/members/:userId` | admin | Remove o membro. |

### Tipos, stores e constantes

| Export | Descrição |
|---|---|
| `TeamRole` | `string` — nome livre de papel. |
| `Membership` | `{ tenantId, userId, role, createdAt }`. |
| `Invitation` / `PublicInvitation` | Convite com/sem o campo `token`. |
| `MembershipStore` / `InvitationStore` | Interfaces para implementares sobre a tua BD. |
| `MemoryMembershipStore` / `MemoryInvitationStore` | Implementações em memória (dev/testes). |
| `RoleAssigner` | `{ assignRole(userId, role, scope), removeRole(...) }`. |
| `DEFAULT_ROLE_RANK` | `{ owner: 3, admin: 2, member: 1 }`. |
| `OWNER` | A string `'owner'`. |
| `TEAMS` | Token de injeção: `container.get(TEAMS)` → `Teams`. |

### Erros

| Erro | Código | HTTP |
|---|---|---|
| `TeamInviteInvalidError` | `TEAM_INVITE_INVALID` | 400 |
| `NotATeamMemberError` | `TEAM_NOT_A_MEMBER` | 403 |
| `InsufficientTeamRoleError` | `TEAM_ROLE_REQUIRED` | 403 |
| `LastOwnerError` | `TEAM_LAST_OWNER` | 400 |

## Erros comuns e soluções (FAQ)

**"O convite é criado mas ninguém recebe email."** O módulo não envia emails — emite o hook `team:invited` com `{ invitation, token }`; a tua aplicação escuta-o e envia o link.

**"400 TEAM_INVITE_INVALID ao aceitar."** O token já foi usado (é de utilização única), expirou (`inviteTtl`, 7 dias), foi revogado, ou foi substituído por um convite mais recente para o mesmo email.

**"403 TEAM_NOT_A_MEMBER numa rota com teamRole."** O guard precisa de `ctx().user` **e** `ctx().tenant`. Confirma que o auth e a tenancy estão registados e que o pedido leva as credenciais e o identificador de tenant (ex.: header `x-tenant-id` em dev).

**"400 TEAM_LAST_OWNER ao remover/despromover alguém."** É a proteção do último owner. Promove primeiro outra pessoa a `owner`.

**"Como crio a primeira equipa?"** Ao criar o tenant, chama `teams.addMember(tenantId, userId, 'owner')` diretamente — os convites são para os seguintes.

**"Os membros desaparecem ao reiniciar."** Stores em memória. Implementa `MembershipStore` e `InvitationStore` sobre a tua base de dados (podes guardar só o hash do token do convite, como sugere o comentário no tipo `Invitation`).

## Como se liga aos outros módulos

- **@machize/tenancy** — a equipa É o conjunto de utilizadores de um tenant; as rotas e o guard leem `ctx().tenant.id`.
- **@machize/auth** — identifica quem faz o pedido (`ctx().user.id`), usado pelo guard `teamRole` e por `accept`.
- **@machize/permissions** — via a opção `access` (`RoleAssigner`), os papéis de equipa tornam-se papéis no scope do tenant, ganhando as permissões que definires para eles no Gate.
- **@machize/core / @machize/fastify** — container, contexto, hooks e execução dos guards e rotas.
