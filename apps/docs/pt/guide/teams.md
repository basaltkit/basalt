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

Os roles são strings livres; sobrepõe a hierarquia com um mapa nome → rank. Só os
roles **com rank** têm hierarquia: um requisito com rank admite esse rank ou
superior (nunca quem tem um role sem rank), e um requisito fora do mapa (p. ex.
uma entrada de `grantableRoles`) é comparado de forma **exacta** — nunca tem
rank 0 nem admite todos os membros:

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
saltam a verificação. "Não o supere" é intencional — pares gerem pares (um admin
pode alterar o role ou remover outro admin); dá a um nível o seu próprio rank se
só puder ser gerido de cima.
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
| `GET /team/members` | `member` (acrescenta `user` com `memberContacts: true`) |
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

O role exigido tem de ser **conhecido** — estar em `roleRank` ou em
`grantableRoles`. Um erro de escrita (`'Admin'`, `'adimn'`), uma string vazia ou
um valor não-string **faz falhar o arranque**: o `teamsPlugin` regista um
validador de meta de rota que todos os adaptadores correm sobre as suas rotas
antes de servir, por isso a app recusa arrancar com `InvalidRouteMetaError`
(`HTTP_INVALID_ROUTE_META`) a indicar a rota e o valor — o `allowUnguardedMeta`
não o dispensa. Uma rota que escape à verificação de arranque (montada fora da
lista do adaptador, ou corrida diretamente via `runRoute()`) continua a falhar
fechado com `500 TEAM_ROLE_UNKNOWN` em todos os pedidos (antes do
`@basaltkit/teams` 4.0 tinha rank 0 e admitia qualquer membro). Só `undefined` e
`false` significam "sem requisito". O mesmo vale para
`tenantMembershipPlugin({ role })`, que lança `UnknownTeamRoleError` no arranque.

O `teamsPlugin` regista também uma verificação de visibilidade pura
(`http:route-visibility`), por isso listagens como o `tools/list` do
`@basaltkit/mcp` escondem uma rota com `meta.teamRole` de quem não tem esse role
no tenant atual — vê [MCP](/pt/guide/mcp#what-tools-list-shows).

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
por email por equipa). Os endereços são comparados e guardados na forma canónica
(sem espaços, em minúsculas — a mesma normalização do `@basaltkit/auth`), por isso
`Bob@x.test` e `bob@x.test` são o mesmo convidado, incluindo linhas com maiúsculas
anteriores à 4.0. Por HTTP:

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

### Aceitação automática com email verificado {#auto-accept-on-verified-email}

O link é apenas a forma como o token viaja. O que o `accept` verifica é que o
convite está vivo e que o email **verificado** de quem aceita é o endereço
convidado. Quando alguém se regista com o endereço convidado e o confirma, os dois
factos já estão provados, por isso obrigá-lo também a encontrar e abrir o email do
convite não acrescenta nada. Adere com:

```ts
teamsPlugin({ acceptOnVerifiedEmail: true })
```

No `auth:email_verified` e no `auth:login`, o convite pendente do utilizador
autenticado para o tenant **atual** (`ctx().tenant`) é aceite quando o seu email
está verificado. As duas ordens funcionam: convidado e depois verificado, e uma
conta já verificada convidada mais tarde (entra no próximo login). A mesma lógica
está disponível diretamente como
`teams.acceptByEmail({ tenantId, userId, email, emailVerified })`.

- **As mesmas garantias do link.** Só um convite pendente, não revogado e não
  expirado; o endereço canónico tem de coincidir; o compare-and-set no convite faz
  com que chamadas concorrentes inscrevam uma só vez; uma pertença existente de
  posto igual ou superior nunca é despromovida.
- **Limitado ao tenant.** Só o tenant em que o utilizador está a entrar. No apex
  (sem tenant) não acontece nada, e os convites para outros tenants continuam
  pendentes: um endereço nunca é inscrito numa organização que não está a visitar.
- **Nunca faz falhar o login.** Um erro (um store indisponível) é reportado
  através de `team:auto_accept_failed` e o convite continua pendente.
- **A política aplica-se a partir desse momento.** O `auth:login` só dispara
  depois do MFA, mas, a partir do momento em que a pertença existe, a política do
  tenant (exigir MFA aos membros, guards de role) aplica-se à conta. Planeia a
  cerimónia como registar → confirmar → já é membro → inscrever o segundo fator.

### Registo só por convite {#invite-only-registration}

O `teamsInviteGate(teams)` é uma política de registo pronta para o
`@basaltkit/auth`: no apex qualquer endereço se pode registar; num host de tenant
só um endereço com um convite vivo para **esse** tenant. Só lê; o convite é
consumido mais tarde (pelo link, ou pelo `acceptOnVerifiedEmail`).

```ts
import { authPlugin } from '@basaltkit/auth'
import { TEAMS, teamsInviteGate, teamsPlugin } from '@basaltkit/teams'

let app: BasaltApp
app = createApp({
  plugins: [
    authPlugin({ users, secret, registerPolicy: teamsInviteGate(() => app.container.get(TEAMS)) }),
    teamsPlugin({ acceptOnVerifiedEmail: true }),
    // tenancy, tenantMembershipPlugin, …
  ],
})
await app.boot()
```

Um registo recusado responde o mesmo `202` que um admitido e emite
`auth:register_refused`, por isso a rota nunca revela quem foi convidado. Ver
[Autenticação: política de registo](/pt/guide/auth#registration-policy).

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

## Notificar toda a gente com um papel

O `members()` devolve identificadores, não pessoas: `{ tenantId, userId, role }`.
Para *enviar email* aos admins de um tenant também precisas dos endereços — e
ir buscá-los às tabelas de auth a partir do código da aplicação acopla o produto
ao schema de auth, enquanto chamar `findById` uma vez por membro são N idas à
base de dados.

Dá um directório de utilizadores ao `Teams` e nenhuma das duas é necessária. Um
`UserSource` do `@basaltkit/auth` satisfaz o contrato tal como está, por isso é o
mesmo objecto que já passas ao `authPlugin`:

```ts
const users = sqliteAuthStores('./data/auth.db').users

plugins: [
  authPlugin({ users, secret }),
  teamsPlugin({ users }),   // o mesmo directório — não há mais nada a ligar
]
```

```ts
const teams = app.container.get(TEAMS)

// Toda a gente que pode agir como admin — owners incluídos (rank 3 >= admin 2).
for (const { user, role } of await teams.roleRecipients('acme', 'admin')) {
  await mailer.send(ApprovalPending, { role }, { to: user.email })
}

// A equipa inteira, com contactos, numa só consulta.
await teams.membersWithUsers('acme')
// [{ tenantId: 'acme', userId: 'u1', role: 'owner', createdAt: 1_7…,
//    user: { id: 'u1', email: 'ada@acme.test', emailVerified: true } }, …]
```

O `membersWithUsers` é a primitiva: é o único sítio onde a consulta ao
directório acontece, e o `roleRecipients` é um filtro sobre ela que não custa
nenhuma consulta adicional. O que o par garante:

- **Uma consulta, automaticamente.** Quando o directório implementa
  [`findByIds`](/pt/guide/auth#pesquisa-de-contactos-em-lote-findbyids), a equipa
  inteira resolve-se numa única consulta em lote; caso contrário recorre a um
  `findById` por membro. A decisão vive num só sítio, por isso uma aplicação
  ganha o caminho rápido no dia em que o seu driver o tiver, sem alterar código.
- **Nenhuma credencial escapa.** O que quer que o directório devolva — o
  `findById` devolve o registo *completo* — é projectado para
  `{ id, email, emailVerified }`.
- **Âmbito do tenant.** Os ids vêm dos registos de membership desse tenant e de
  mais lado nenhum, por isso nenhum chamador pode apontar a consulta a contas à
  sua escolha, e um utilizador que o directório devolva sem ter sido pedido é
  descartado.
- **Contas em falta não partem a lista.** Um membership cuja conta já não existe
  (apagada, ou um convite que nunca chegou a ser um utilizador real) é
  *ignorado* — `user` é obrigatório em `TeamMemberWithUser`, por isso o resultado
  é sempre seguro para enviar email. O registo de membership fica intacto e o
  `members()` continua a mostrá-lo.

O `roleRecipients` respeita a hierarquia para papéis **com rank** e faz
correspondência exacta para os **sem rank** — todos os papéis fora de `roleRank`
têm rank 0, por isso tratá-los por rank notificaria todos de uma vez:

```ts
await teams.roleRecipients('acme', 'admin')                  // owners + admins
await teams.roleRecipients('acme', 'admin', { exact: true }) // só admins
await teams.roleRecipients('acme', 'billing-contact')        // exacto (sem rank)
```

Sem um directório `users`, ambos os métodos lançam `TeamUserSourceMissingError`
(`500 TEAM_USER_SOURCE_MISSING`) em vez de devolverem calados linhas sem
contactos.

Em HTTP os mesmos dados são opt-in: `teamRoutes({ memberContacts: true })`
acrescenta `user` a cada entrada de `GET /team/members` (continua a exigir
`member`). Está desligado por predefinição para que os endereços de email da
equipa só saiam pela rede quando tu o disseres, e os ids resolvidos são sempre
os memberships do próprio tenant — nunca algo que o pedido tenha fornecido.

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
| `users` | `MemberUserSource` | — | Directório de utilizadores (só de leitura) por trás de `membersWithUsers` / `roleRecipients`; um `UserSource` do `@basaltkit/auth` serve tal como está |
| `access` | `RoleAssigner` | — | Espelha cada mudança de membership numa concessão de role de `@basaltkit/permissions` no âmbito do tenant |
| `inviteTtl` | `DurationInput` | `'7d'` | Tempo de vida do link de convite |
| `roleRank` | `Record<string, number>` | `{ owner: 3, admin: 2, member: 1 }` | Hierarquia de roles; roles fora do mapa não têm rank (comparação exacta) |
| `grantableRoles` | `TeamRole[]` | `[]` | Roles sem rank que um utilizador ativo pode ainda conceder; qualquer outro role fora de `roleRank` é recusado (`TEAM_ROLE_NOT_GRANTABLE`) |
| `now` | `() => number` | `Date.now` | Relógio injetável (testes) |
| `acceptOnVerifiedEmail` | `boolean` | `false` | Aceitar o convite pendente do utilizador para o tenant atual no `auth:email_verified` / `auth:login` quando o email está verificado. Ver [Aceitação automática com email verificado](#auto-accept-on-verified-email) |

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
| `memberContacts` | `boolean` | `false` | Incluir `user: { id, email, emailVerified }` de cada membro em `GET /team/members`, resolvido através do directório `users` |

## Modos de falha e troubleshooting

| Erro | Código | HTTP | Quando |
| --- | --- | --- | --- |
| `TeamInviteInvalidError` | `TEAM_INVITE_INVALID` | 400 | Token desconhecido, usado, revogado, expirado — ou resgatado por uma conta cujo email não é o convidado |
| `NotATeamMemberError` | `TEAM_NOT_A_MEMBER` | 403 | `tenantMembershipPlugin` não encontrou membership; ou uma rota com `meta.teamRole` correu sem utilizador **ou** sem tenant no contexto |
| `InsufficientTeamRoleError` | `TEAM_ROLE_REQUIRED` | 403 | Rank do role abaixo do exigido, incluindo um ator a tentar conceder, despromover ou remover acima do seu próprio rank |
| `TeamRoleNotGrantableError` | `TEAM_ROLE_NOT_GRANTABLE` | 403 | Um utilizador ativo tentou conceder um role que não está em `roleRank` nem em `grantableRoles` |
| `TeamEmailNotVerifiedError` | `TEAM_EMAIL_NOT_VERIFIED` | 403 | `POST /team/invites/accept` por um utilizador cujo email não está verificado (ver `requireVerifiedEmail`) |
| `LastOwnerError` | `TEAM_LAST_OWNER` | 400 | A mudança deixaria a equipa sem owner |
| `UnknownTeamRoleError` | `TEAM_ROLE_UNKNOWN` | 500 | `meta.teamRole` / `tenantMembershipPlugin({ role })` indica um role que não está em `roleRank` nem em `grantableRoles` (erro de escrita, `''`, não-string) |
| `TeamUserSourceMissingError` | `TEAM_USER_SOURCE_MISSING` | 500 | `membersWithUsers` / `roleRecipients` (ou `memberContacts: true`) correu sem directório `users` configurado |
| `TEAM_NO_TENANT` | `TEAM_NO_TENANT` | 400 | Um endpoint de `teamRoutes()` foi chamado sem tenant no contexto — regista a tenancy e envia o identificador do tenant |
| `TEAM_INVITE_NOT_FOUND` | `TEAM_INVITE_NOT_FOUND` | 404 | `DELETE /team/invites/:id` para um id que não existe ou pertence a outro tenant |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | arranque | Uma rota declara `meta.teamRole` e `teamsPlugin` não está registado |

- **`TEAM_NOT_A_MEMBER` logo após adicionar um membro noutra réplica** — o
  `ttlMs` da cache de membership limita a desatualização entre réplicas em ambos
  os sentidos; a decisão é refrescada dentro de `ttlMs`.
- **Um role personalizado continua a receber `TEAM_ROLE_REQUIRED`** — roles fora
  de `roleRank` não têm rank: nunca satisfazem um requisito com rank. Adiciona o
  role ao mapa, ou (para o guard de membership) confia na semântica de
  existência predefinida em vez de `role:`.
- **O arranque falha com `InvalidRouteMetaError` … `meta.teamRole "Admin" is not
  a known team role`** — corrige o valor, ou dá rank ao role em `roleRank` /
  lista-o em `grantableRoles` (os roles distinguem maiúsculas).
- **`500 TEAM_ROLE_UNKNOWN` numa rota** — o seu `meta.teamRole` não está em
  `roleRank` nem em `grantableRoles` e a rota escapou à verificação de arranque
  (montada fora da lista de rotas do adaptador); normalmente um erro de escrita.
- **`403` numa rota central (login, registo, criação de tenant)** — marca-a com
  `meta: { central: true }`, ou isenta a identidade que chama com `exempt`.

## Eventos

| Hook | Payload |
| --- | --- |
| `team:invited` | `{ invitation, token }` — envia o email aqui |
| `team:joined` | `{ membership }` |
| `team:role_changed` | `{ membership }` |
| `team:member_removed` | `{ tenantId, userId }` |
| `team:auto_accept_failed` | `{ tenantId, userId, error }` — o `acceptOnVerifiedEmail` não conseguiu inscrever; o login seguiu, o convite continua pendente |

O fluxo completo — incluindo o encanamento de email — está no
[cookbook do ciclo de vida da conta](/pt/cookbook/account-lifecycle).
