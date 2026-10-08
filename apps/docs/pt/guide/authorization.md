# Autorização (permissions)

A autenticação diz-te *quem* é o utilizador; o
[`@basaltkit/permissions`](/reference/packages/permissions) decide *o que* ele pode
fazer. Centraliza essas decisões num **Gate** a quem perguntas "este utilizador pode
fazer `projects:delete`?" — com roles, permissões wildcard e políticas de recurso,
tudo **scoped por tenant** por omissão.

[[toc]]

## Modelo mental

O Gate é **default-deny**: um check só passa quando algo o concede
explicitamente — uma permissão concedida ao utilizador, um role que ele detém,
uma concessão temporária ou delegação ativa, ou uma política de recurso que
corresponda. Nada concedido → `false`. As concessões são procuradas no **scope
do tenant atual e no scope global** (`GLOBAL_SCOPE`); em mais lado nenhum.

A proteção de rotas divide-se entre chaves de meta e o plugin cujo guard impõe
cada uma:

| Meta da rota | Imposta por | Rejeita com |
| --- | --- | --- |
| `meta.auth` | `authPlugin` ([guia de auth](/pt/guide/auth)) | `401 AUTH_REQUIRED` |
| `meta.can` | `permissionsPlugin` (esta página) | `403 PERMISSION_DENIED` |
| `meta.teamRole` | `teamsPlugin` ([guia de teams](/pt/guide/teams)) | `403 TEAM_ROLE_REQUIRED` |
| `meta.scopes` | `apiKeysPlugin` ([guia de auth](/pt/guide/auth)) | `403 SCOPE_REQUIRED` |
| `meta.subscribed` | `subscriptionsPlugin` ([guia de faturação](/pt/guide/billing)) | `402 NOT_SUBSCRIBED` |
| `meta.feature` | `subscriptionsPlugin` ([guia de faturação](/pt/guide/billing)) | `402 FEATURE_UNAVAILABLE` |
| `meta.tenant` | `tenancyPlugin` ([guia de tenancy](/pt/guide/tenancy)) | `404 TENANCY_NOT_RESOLVED` / `404 NOT_FOUND` |

O `meta.tenant` é o caso à parte: não é um guard mas um *requisito*, lido durante
a resolução do tenant — `false` marca a rota como central, `true` exige tenant
mesmo quando o default da app está desligado, e `'never'` recusa um tenant
resolvido com o 404 simples de «rota inexistente», antes de qualquer guard. Por
isso não é abrangido pela verificação de chaves sem guard abaixo; o
`tenancyPlugin` valida os seus valores no arranque.

Declarar uma destas chaves sem registar o plugin que a impõe não serve a rota
silenciosamente sem proteção — o adapter recusa-se a fazer **boot** com
`UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`). Vê
[Modos de falha](#modos-de-falha-e-troubleshooting) e o
[guia de adapters](/pt/guide/adapters).

## Conceder e perguntar

As permissões são labels como `projects:delete`; os roles são conjuntos nomeados
delas. As concessões vivem num `AccessStore` (em memória em dev, a tua base de dados
em produção).

```ts
import { Gate, MemoryAccessStore, GLOBAL_SCOPE } from '@basaltkit/permissions'

const store = new MemoryAccessStore()
await store.grantToRole('admin', ['projects:*', 'billing:read'], GLOBAL_SCOPE)
await store.assignRole('user-ada', 'admin', GLOBAL_SCOPE)

const gate = new Gate({ store })
await gate.can({ id: 'user-ada' }, 'projects:delete') // true — projects:* cobre-o
await gate.can({ id: 'user-bob' }, 'projects:delete') // false
```

O `gate.authorize(user, perm)` é a variante que lança — levanta
`PermissionDeniedError` (`403 PERMISSION_DENIED`) em vez de devolver `false`.
O `gate.hasRole(user, role)` responde diretamente sobre a posse de um role — os
roles que o utilizador tem de facto, no scope atual ou globalmente. Um
`superAdmin` **não** é membro de todos os roles (era, antes do
`@basaltkit/permissions` 4.0): o bypass curto-circuita `can()`/`authorize()`/`meta.can`,
e o `gate.isSuperAdmin(user)` pergunta por ele explicitamente. Onde o `hasRole()`
guardava uma ação, verifica antes a permissão.

### Os wildcards correspondem segmento a segmento

Um padrão concedido é comparado com a permissão pedida **um segmento separado
por `:` de cada vez**, e o número de segmentos tem de coincidir:

```ts
'projects:*'  covers 'projects:delete'      // ✅ same depth, second segment wildcarded
'projects:*'  covers 'projects:read'        // ✅
'projects:*'  does NOT cover 'projects:delete:all' // ❌ 2 segments vs 3 — no match
'*'           covers everything             // ✅ the one exception: a super admin
'projects:*'  does NOT cover 'projects:'    // ❌ an empty segment never matches
```

Assim, uma concessão de dois níveis nunca absorve silenciosamente uma permissão
mais profunda e específica que adiciones mais tarde — concede `projects:*:*`
(ou a string exata) se quiseres o nível mais profundo. O `'*'` simples
corresponde a qualquer permissão, independentemente da profundidade.

Uma permissão com um **segmento vazio** — `''`, `'projects:'`, `':read'`,
`'projects::read'` — é malformada e não corresponde a nada, nem a si própria, e
nenhum wildcard a cobre (`hasEmptySegment()` di-lo, a partir da mesma entrada
`@basaltkit/permissions/match`, segura para o browser). O Gate recusa-a logo:
`can()`, todas as concessões e o `roleCatalog` lançam `TypeError`.

## Políticas de recurso

Para regras que dependem do recurso *específico* — "só o dono do projeto o pode
editar" — define uma política: um **nome de recurso** mais um mapa de **ações**
para funções de check. Um check recebe o utilizador e a instância do recurso:

```ts
import { definePolicy } from '@basaltkit/permissions'

const ProjectPolicy = definePolicy<Project>('project', {
  update: (user, project) => project.ownerId === user.id,
  delete: (user, project) => project.ownerId === user.id,
})

gate.register(ProjectPolicy)

// Pass the resource: 'project:update' → the 'project' policy's 'update' check runs
await gate.can({ id: 'u1' }, 'project:update', project)
```

Quando passas um recurso, o Gate divide a permissão em `resource:action`,
procura a política registada para esse recurso e deixa o check dela decidir. As
políticas podem ser registadas à partida via a opção `policies` ou mais tarde
com `gate.register(...)`; os checks podem ser async.

Para aplicar uma política numa rota, declara o recurso no `meta.can` — vê
[Políticas no guard](#politicas-no-guard-requisitos-de-recurso). O guard carrega então o recurso e corre a política,
por isso nenhum handler se pode esquecer da chamada.

::: danger Sem política ⇒ o check falha fechado
Passar um recurso é uma declaração explícita de que deve ser uma regra ABAC a
decidir, por isso se nenhuma política estiver registada para esse recurso — ou
se a política não tiver check para essa ação — o Gate lança `MissingPolicyError`
(`PERMISSION_POLICY_MISSING`) em vez de responder a partir do RBAC. Antes caía
silenciosamente, o que significava que um erro de escrita (`project:updat`, ou
`projects:update` para uma política registada como `project`) saltava por
completo a regra de posse e uma concessão ampla `project:*` autorizava o pedido.

O erro nomeia a permissão e lista as políticas registadas. Corrige registando o
check, corrigindo a escrita de `resource:action`, ou removendo o argumento do
recurso se o que querias era RBAC simples. Para repor o comportamento histórico
— em apps que passam recursos oportunisticamente — define
`onMissingPolicy: 'rbac'`.
:::

A correspondência é exata. Só contam as ações **próprias** da política —
`project:constructor` ou `project:toString` nunca chegam a `Object.prototype`,
são políticas em falta — e só um `resource:action` de dois segmentos escolhe um
check: `project:update:billing` é uma permissão diferente de `project:update`,
por isso o check `update` não a decide. Um check só autoriza quando devolve
`true` (um valor truthy que não seja booleano nega). O `can()` recusa uma
permissão que não seja uma string não vazia sem espaços nem segmentos `:` vazios (`TypeError`), e um
utilizador sem `id` de texto não vazio não está autenticado: `can`/`authorize`/
`hasRole` lançam `AuthRequiredGuardError` (401) em vez de avaliar — ou rebentar
com — um chamador anónimo.

## Proteger rotas

Regista o `permissionsPlugin` e declara a permissão que uma rota precisa com
`meta.can` — o plugin protege-a automaticamente, lendo o utilizador autenticado do
contexto:

```ts
import { permissionsPlugin } from '@basaltkit/permissions'

app.use(permissionsPlugin({ store }))

route({
  method: 'DELETE', url: '/projects/:id',
  meta: { can: 'projects:delete' }, // 403 a menos que o utilizador a tenha
  async handler({ params }) { /* … */ },
})
```

Um pedido anónimo a uma rota com `meta.can` é rejeitado com `401 AUTH_REQUIRED`
antes de qualquer check de permissão — combina com o
[`authPlugin`](/pt/guide/auth) para que `ctx().user` esteja preenchido.

O `meta.can` aceita uma string de permissão ou um **array — o caller tem de as
ter todas**:

```ts
meta: { can: ['reports:read', 'reports:export'] } // 403 a menos que o utilizador tenha AMBAS
```

Qualquer outra forma (`can: true`, um número, um array vazio, uma entrada que
não é nem uma permissão nem um [requisito de recurso](#politicas-no-guard-requisitos-de-recurso)) não é
aplicável e **falha fechada**: o guard lança `InvalidCanMetaError`
(`PERMISSION_META_INVALID`, HTTP 500) em cada pedido em vez de saltar o check
silenciosamente. E declarar `meta.can` sem registar o `permissionsPlugin` falha
no **boot** — vê o guia de adapters.

### As listagens escondem o que o chamador não passa

O plugin regista também uma **verificação de visibilidade pura** para o
`meta.can` em `http:route-visibility`, para que superfícies de listagem — o
[`tools/list` do MCP](/pt/guide/mcp#what-tools-list-shows) — deixem de fora as
rotas cujas permissões faltam ao chamador. Faz a mesma pergunta que o guard,
`gate.can(user, permission)` para cada entrada, no scope atual (o `superAdmin`
passa sempre, como no guard), mas **sem efeitos secundários**: o `can()` só lê
grants — nunca emite `permission:denied`, por isso uma listagem nunca aparece no
rasto de auditoria (mantém o `superAdmin` puro; também corre aqui). Sem
utilizador, ou com um `meta.can` malformado, a rota fica escondida, tal como o
guard a recusaria.

As policies nunca entram — uma listagem nunca carrega um recurso. Um
[requisito de recurso](#politicas-no-guard-requisitos-de-recurso) decidido por uma política não levanta
objeção para um chamador autenticado (um dono pode passar sem grant nenhum), e
uma regra de propriedade que o próprio handler corre também é invisível: essa
tool continua listada e é recusada na chamada. Visibilidade nunca é
autorização: cada chamada corre sempre o guard.

### Políticas no guard (requisitos de recurso)

Um `meta.can: 'projects:update'` simples é RBAC — o guard não passa recurso,
por isso uma política registada nunca corre e `projects:*` atualiza *todos* os
projetos. Declara o recurso e o guard aplica a política:

```ts
import { canResource, definePolicy, permissionsPlugin } from '@basaltkit/permissions'

const ProjectPolicy = definePolicy<Project>('projects', {
  update: (user, project) => project.ownerId === user.id,
})

app.use(permissionsPlugin({ store, policies: [ProjectPolicy] }))

route({
  method: 'PATCH', url: '/projects/:id',
  params: z.object({ id: z.string() }),
  body: z.object({ name: z.string() }),
  meta: {
    can: {
      permission: 'projects:update',
      resource: ({ params }) => projects.findById(params.id), // null → 404
    },
  },
  // Carregado e autorizado pelo guard — lê-o de volta, não o carregues outra vez.
  async handler({ body }) {
    return projects.rename(canResource<Project>(), body.name)
  },
})
```

O guard responde `401` sem utilizador (antes de qualquer carregamento), verifica
primeiro as permissões simples de um array (um chamador recusado pelo RBAC nunca
provoca um carregamento), e depois, para cada requisito, carrega o recurso e
chama `gate.authorize(user, permission, resource)`: **a política decide**,
exatamente como quando chamas o Gate à mão. O loader recebe
`{ params, query, body, user, tenant, container, request, route }` — `params`,
`query` e `body` validados pelos schemas da rota tal como o handler os recebe
(input inválido é o `400` habitual; mantém as transformações dos schemas puras,
correm para o loader e outra vez para o handler). Requisitos que partilham um
loader carregam uma só vez.

| Situação | Resposta |
| --- | --- |
| O loader devolve `null` / `undefined` | `404 RESOURCE_NOT_FOUND` — ou, com `notFound: 'deny'` (por requisito) / `resourceNotFound: 'deny'` (plugin), um `403 PERMISSION_DENIED` auditado, para que não se possam sondar ids |
| O loader lança | O erro propaga-se inalterado — nunca um allow |
| A política devolve algo que não `true` | `403 PERMISSION_DENIED` + `permission:denied` |
| Nenhuma política decide a `permission` | Recusado no **boot** (abaixo); com `onMissingPolicy: 'rbac'` arranca e decidem os grants |

Os arrays misturam as duas formas, all-of como antes — exige o grant **e** a
política com `can: ['projects:update', { permission: 'projects:update', resource: load }]`.
Com vários requisitos, `canResource('projects:publish')` escolhe um pela
permissão.

O plugin valida a forma com recurso no **boot** através do bucket
`http:meta-validators`, que todos os adapters correm: um requisito malformado
(sem loader, uma permissão inválida, uma chave desconhecida, um `notFound`
inválido) ou um cujo `resource:action` nenhuma política registada decide recusa
arrancar com `InvalidRouteMetaError` (a menos que `onMissingPolicy: 'rbac'`).
Regista as políticas em `permissionsPlugin({ policies })`.

Comporta-se de forma idêntica em Fastify, Express e Hono e através de chamadas
de tools MCP — é um guard do pipeline partilhado. Chamar o Gate dentro do
handler continua disponível para o que uma rota não consegue declarar: um
segundo recurso, uma decisão sobre um valor que o handler calcula, jobs em
background.

## Audiências — a que superfície uma rota pertence

Uma permissão é uma capacidade, não uma superfície. O `matter:read` não distingue
"ler o meu próprio processo no portal do cliente" de "ler o processo com a
estratégia processual lá dentro", portanto um papel a quem se concedeu o primeiro
passa também no guard do segundo.

Não é hipotético: foi assim que um cliente autenticado recebeu `200 OK` numa
listagem interna, com a estratégia do próprio caso no corpo.

O `audiences` dá nome às superfícies, e o `meta.audience` diz qual é a de cada
rota:

```ts
app.use(permissionsPlugin({
  store,
  audiences: {
    portal: { roles: ['client'], allow: ['portal', 'public'] },
  },
}))

route({
  method: 'GET', url: '/portal/matters',
  meta: { can: 'matter:read', audience: 'portal' },
  async handler() { /* … */ },
})
```

### O default é que é o ponto

**Uma rota que não declara audiência é inalcançável por um papel confinado.** Não
"alcançável a menos que marcada como interna" — ao contrário.

O desenho óbvio é marcar as rotas internas, e falha na primeira vez que alguém
acrescenta uma rota sem pensar em portais. Marcar a superfície pequena e
deliberada que um papel restrito pode alcançar é uma lista que alguém mantém;
marcar todas as que não pode é uma lista que alguém esquece, uma vez, em silêncio.

### Quem fica confinado

| O chamador tem | Resultado |
| --- | --- |
| Pelo menos um papel que nenhuma regra nomeia | **Não confinado.** As audiências não dizem nada sobre ele |
| Só papéis que as regras nomeiam | **Confinado** à união dos `allow` dessas regras |
| Nenhum papel | Não confinado aqui — também não tem permissão nenhuma, e o `meta.can` já responde |

A linha do meio é a razão por que um advogado que também é cliente do próprio
escritório continua a trabalhar: recusá-lo trancaria um membro do staff fora do
seu próprio local de trabalho no dia em que o escritório o tornasse cliente.
Confina-se só quem não tem mais nada.

A união na segunda linha significa que dois papéis confinados dão alcance cada um
à sua superfície, e ter os dois dá as duas — o que nenhum nomeia fica fechado.

"Os papéis que tem" são os papéis no tenant atual ou — quando o tenant não dá
nenhum — os do `GLOBAL_SCOPE` (`gate.audienceRoles(userId)`). Um papel `client`
atribuído globalmente confina quem o tem dentro de qualquer tenant onde não tenha
papel próprio, não só fora de um. E um papel global de base sem regra (um `user`
que cada registo recebe) não desconfina um cliente dentro do seu tenant: aí
decidem os papéis do próprio tenant.

**As audiências estreitam; nunca alargam.** A verificação de permissão corre à
mesma: um chamador sem `matter:read` é recusado em `/portal/matters`, coincida ou
não a audiência. Nomear uma audiência não é uma porta de entrada.

Omite o `audiences` por completo e nada disto se aplica.

## Scoping por tenant

As concessões são **por tenant** por omissão: `projects:*` concedido em `acme` não se
aplica em `globex`. Cada check consulta exatamente dois scopes — o atual (por
omissão `ctx().tenant.id`, caindo para `GLOBAL_SCOPE` fora de um contexto de
tenant) e o scope global. Usa `GLOBAL_SCOPE` para concessões que se aplicam em
todo o lado, e a opção `scope` para derivar o scope atual de outra forma. Em
produção, troca o `MemoryAccessStore` por um `AccessStore` durável
(`@basaltkit/permissions-prisma` / `-sqlite` no ecossistema).

### Um catálogo de roles para todos os tenants

As permissões de um role são procuradas **no scope onde o role é detido**. O
`@basaltkit/teams` espelha as memberships por tenant (`assignRole(user,
'owner', tenantId)`), por isso um catálogo como "owner = `*`" concedido uma vez
em `GLOBAL_SCOPE` nunca chega ao owner de um tenant — e copiá-lo para cada
tenant diverge. Define-o uma vez:

```ts
permissionsPlugin({
  store,
  // (a) Definido em código, válido em todos os scopes.
  roleCatalog: {
    owner: ['*'],
    admin: ['projects:*', 'members:invite'],
    member: ['projects:read'],
  },
  // (b) Ou mantém o catálogo no store, sob GLOBAL_SCOPE.
  inheritGlobalRolePermissions: ['admin', 'member'], // ou `true` para todos os roles
})
```

- **`roleCatalog`** — um role detido num scope concede as permissões do
  catálogo **nesse scope**: o owner de `acme` recebe `*` em `acme`, nada em
  `globex`, nada globalmente. Um role detido em `GLOBAL_SCOPE` aplica-se em todo
  o lado, como os roles globais sempre fizeram.
- **`inheritGlobalRolePermissions`** — um role detido num tenant resolve também
  as suas permissões a partir da definição em `GLOBAL_SCOPE`, concedendo apenas
  nesse tenant. Prefere uma lista de nomes de roles quando os admins dos tenants
  podem atribuir roles: com `true`, atribuir dentro de um tenant um
  `platform-admin` definido globalmente concede lá o seu conjunto global de
  permissões.

Ambos são uniões com o que o store concede ao role no tenant, usam a mesma regra
de wildcards e concedem **permissões, nunca roles**: `hasRole()`,
`effectiveRoles()` e o confinamento por audiências não mudam. O `GET /me/access`
(`accessRoutes()`) reporta a mesma resolução (`gate.rolePermissions(role,
scope)`).

### O scope global não pode ser um tenant

O `GLOBAL_SCOPE` é `'@global'` — um valor que nenhum slug, label de hostname ou
uuid pode tomar. (Antes do `@basaltkit/permissions` 1.5 era `'global'`: as
concessões são indexadas pelo id do tenant, por isso o dono de um tenant
*chamado* `global` tinha os seus papéis em todos os tenants.) O Gate recusa
avaliar um pedido cujo id de tenant seja `'@global'` ou `'global'` —
`ReservedScopeError`, `PERMISSION_SCOPE_RESERVED`, 403 — e o
`isReservedScope(id)` deixa o teu registo de tenants recusar esses ids no
registo. O mesmo erro responde a um pedido que traz um tenant sem id de texto
não vazio: é um contexto partido, e cair no scope global avaliaria (e deixaria o
`gate.assignRole()` com o scope por omissão escrever) o balde de toda a
plataforma.

**Upgrade a partir de ≤ 1.4:** as linhas guardadas com o literal `'global'` já
não são lidas como globais. Migra-as:

```sql
UPDATE perm_user_roles       SET scope = '@global' WHERE scope = 'global';
UPDATE perm_user_permissions SET scope = '@global' WHERE scope = 'global';
UPDATE perm_role_permissions SET scope = '@global' WHERE scope = 'global';
```

Entretanto, `readLegacyGlobalScope: true` continua a lê-las — uma ajuda de
transição: enquanto estiver ligada, um tenant com id `'global'` volta a escrever
concessões globais, por isso reserva esse id antes de a ligar.

### As escritas precisam de um tenant (ou de um scope explícito)

`gate.assignRole()`, `removeRole()`, `grantToRole()`, `grantToUser()`,
`grantTemporarily()` e `delegate()` aceitam um `scope` opcional. Sem ele,
escrevem no tenant atual. Numa app multi-tenant — com o `tenancyPlugin`
registado — uma escrita sem scope e **sem tenant no contexto** lança
`ScopeRequiredError` (`PERMISSION_SCOPE_REQUIRED`, 400) em vez de cair em
`GLOBAL_SCOPE`: um endpoint de administração de tenant chamado num pedido cujo
tenant não foi resolvido não pode escrever uma concessão de toda a plataforma.

```ts
await gate.assignRole(userId, 'admin')               // inside a tenant: that tenant
await gate.assignRole(userId, 'admin', GLOBAL_SCOPE) // a global grant: say so
```

As apps single-tenant (sem plugin de tenancy) não são afetadas: as escritas sem
scope continuam a ir para `GLOBAL_SCOPE`. Uma opção `scope` personalizada decide
por si, e `allowGlobalWrites: true` repõe o fallback antigo por inteiro. Um Gate
construído à mão (`new Gate(...)`) sabe que a tenancy está ativa pela opção
`tenancyActive`; o `permissionsPlugin` liga-a ao marcador do `tenancyPlugin`.

## Concessões temporárias e delegação

Dois mecanismos limitados no tempo assentam sobre as concessões permanentes.
Ambos são **opt-in** — cada um precisa do seu store ligado ao Gate (versões em
memória para dev/testes):

```ts
import {
  Gate, MemoryAccessStore, MemoryTemporaryGrantStore, MemoryDelegationStore,
} from '@basaltkit/permissions'

const gate = new Gate({
  store: new MemoryAccessStore(),
  temporaryGrants: new MemoryTemporaryGrantStore(),
  delegations: new MemoryDelegationStore(),
})
```

As **concessões temporárias** dão a um utilizador permissões extra até uma
expiração — acesso break-glass, uma tarefa limitada no tempo. As concessões
ativas juntam-se às permissões próprias do utilizador durante o check:

```ts
const grant = await gate.grantTemporarily('user-bob', ['deploys:approve'], {
  ttlMs: 60 * 60_000,          // or an absolute `expiresAt` (epoch ms)
  grantedBy: 'user-ada',       // optional audit fields
  reason: 'covering on-call',
})
// after expiry the grant is inert; revoke earlier via the store: store.revoke(grant.id)
```

Uma concessão temporária precisa de um prazo: o `grantTemporarily()` lança um
`TypeError` sem `ttlMs` nem `expiresAt` (antes escrevia uma concessão já
expirada), e recusa um prazo que não seja um instante finito no futuro —
`Infinity` é uma concessão permanente, por isso usa `grantToUser()` para isso.

A **delegação** permite a um utilizador agir com um subconjunto da autoridade
de *outro utilizador*:

```ts
await gate.delegate({
  from: 'user-ada',                // whose authority is lent
  to: 'user-bob',                  // who may act with it
  permissions: ['projects:*'],     // patterns; '*' = everything the delegator can do
  expiresAt: Date.now() + 86_400_000, // omit for open-ended
})
```

A autoridade delegada é limitada **no momento do check** pelo que o delegante
pode fazer *diretamente* — uma delegação nunca concede mais do que o delegante
tem *neste momento* (revoga o acesso da Ada e o acesso delegado do Bob morre
com ele), e as delegações não encadeiam (o Bob não pode re-delegar a autoridade
da Ada; um check através de uma delegação ignora as delegações recebidas pelo
próprio delegante).

O Gate não confia nos stores em nada disto: o que `activeFor()` / `activeTo()`
devolvem é verificado de novo contra o utilizador, o scope e o relógio do
próprio Gate (`now`), por isso um store durável que esqueça o filtro
`expires_at > ?` não consegue transformar uma concessão limitada no tempo numa
permanente.

Em produção, apoia ambos numa base de dados — os stores `Memory*` são por
processo, por isso uma concessão ou delegação morre com o processo e é invisível
às outras instâncias. O `@basaltkit/permissions-prisma` e o
`@basaltkit/permissions-sqlite` devolvem stores duráveis ao lado do access store
(ver [Persistência](/pt/guide/persistence)):

```ts
const p = prismaAccessStore(prisma) // ou sqliteAccessStore('./data/permissions.db')
permissionsPlugin({ store: p.store, temporaryGrants: p.temporaryGrants, delegations: p.delegations })
```

## O que posso fazer? — `GET /me/access`

O `accessRoutes()` acrescenta `GET /me/access`: os roles e as permissões de quem
pergunta, para que a interface esconda os controlos que devolveriam `403` — e
mostre os que abrem. Não é uma superfície de segurança (cada pedido continua a
ser decidido pelo Gate) e não tem `meta.auth`: um chamador anónimo recebe uma
resposta vazia, não um `401`.

```ts
fastifyPlugin({ routes: [...accessRoutes(), ...myRoutes] })
```

A resposta é o `gate.describeAccess(user)`, e cobre **todas as fontes que um
check respeita**: grants no tenant atual *e* no `GLOBAL_SCOPE` (mais o scope
global legado quando o `readLegacyGlobalScope` está ligado), o catálogo de roles
e as definições globais herdadas, concessões temporárias vivas, delegações vivas
— já reduzidas ao que o delegante tem — e o bypass `superAdmin`:

```json
{
  "roles": ["editor"],
  "permissions": ["billing:read", "docs:*", "reports:export"],
  "superAdmin": false,
  "grants": [
    { "permission": "docs:*", "source": "role", "scope": "acme", "role": "editor" },
    { "permission": "billing:read", "source": "direct", "scope": "@global" },
    { "permission": "reports:export", "source": "temporary", "scope": "acme", "id": "…", "expiresAt": 1767225600000 }
  ]
}
```

- `roles` — os que tem no scope atual ou globalmente (aquilo para que o `hasRole()` responde `true`);
- `permissions` — ordenadas e sem repetições; o `permitted(permissions, p)` do
  `@basaltkit/permissions/match` dá a mesma resposta que `gate.can(user, p)`.
  Um super admin recebe `'*'`;
- `grants` — a `source` de cada permissão (`'direct'`, `'role'`, `'temporary'`,
  `'delegation'`, `'super-admin'`), o `scope` onde vive, e `role`, `id`,
  `fromUserId`, `expiresAt` quando se aplicam. Uma permissão delegada expira no
  mais cedo entre o prazo da delegação e o da concessão temporária do delegante
  em que assenta. Volta a pedir antes do `expiresAt` mais próximo.

Antes do `@basaltkit/permissions` 4.0 a rota lia só os grants permanentes do
tenant atual, por isso um grant global, uma concessão temporária, uma delegação
ou o bypass de super admin abriam a porta no servidor enquanto o menu a
escondia.

## Referência de opções

O `permissionsPlugin(options)` recebe as mesmas opções que `new Gate(options)`:

| Opção | Tipo | Omissão | Propósito |
| --- | --- | --- | --- |
| `store` | `AccessStore` | — (obrigatória) | Onde vivem roles/permissões — a tua base de dados em produção |
| `superAdmin` | `(user) => boolean \| Promise<boolean>` | — | Curto-circuita **todos** os checks para `true` quando devolve `true` (o `Gate::before` do Laravel). Não é um role: o `hasRole()` continua a responder sobre a posse; o `isSuperAdmin(user)` pergunta pelo bypass |
| `scope` | `() => string` | `ctx().tenant.id` ?? `GLOBAL_SCOPE` | Scope atual; os checks consultam-no mais o `GLOBAL_SCOPE` |
| `policies` | `Policy[]` | `[]` | Políticas de recurso registadas à partida (o mesmo que chamar `gate.register`) |
| `temporaryGrants` | `TemporaryGrantStore` | desligado | Ativa `grantTemporarily()` |
| `delegations` | `DelegationStore` | desligado | Ativa `delegate()` |
| `now` | `() => number` | `Date.now` | Relógio injetável (testes) |
| `onMissingPolicy` | `'error' \| 'rbac'` | `'error'` | O que `can(user, perm, resource)` faz quando nenhum check de política corresponde a `resource:action`: `'error'` lança `MissingPolicyError` (falha fechada), `'rbac'` volta às strings de permissão concedidas. Decide também se um requisito de recurso sem política recusa o boot |
| `resourceNotFound` | `'not-found' \| 'deny'` | `'not-found'` | Só no plugin. O que um [requisito de recurso](#politicas-no-guard-requisitos-de-recurso) responde quando o loader não encontra nada: `404 RESOURCE_NOT_FOUND` ou um `403 PERMISSION_DENIED` auditado |
| `roleCatalog` | `Record<string, string[]>` | — | Role → permissões definido em código, válido em todos os scopes; um role só as concede no scope onde é detido. Vê [Um catálogo de roles para todos os tenants](#um-catalogo-de-roles-para-todos-os-tenants) |
| `inheritGlobalRolePermissions` | `boolean \| string[]` | `false` | Um role detido num tenant resolve também as permissões da sua definição em `GLOBAL_SCOPE` (só nesse tenant); uma lista limita-o a esses roles |
| `readLegacyGlobalScope` | `boolean` | `false` | Ler também as linhas do scope global anterior à 1.5 (`'global'`) como globais. Ajuda de transição — vê [O scope global não pode ser um tenant](#o-scope-global-nao-pode-ser-um-tenant) |
| `hooks` | `HookBus` | o bus da app (plugin) | Onde os hooks `permission:*` são emitidos |
| `allowGlobalWrites` | `boolean` | `false` | Deixar uma escrita sem scope fora de um tenant cair em `GLOBAL_SCOPE` mesmo com a tenancy ativa. Vê [As escritas precisam de um tenant](#as-escritas-precisam-de-um-tenant-ou-de-um-scope-explicito) |
| `tenancyActive` | `() => boolean` | o marcador `tenancy:active` (plugin); `false` (`new Gate`) | Se a app é multi-tenant — decide se as escritas sem scope fora de um tenant falham fechadas |

O plugin regista o Gate sob o token `GATE`, adiciona o guard do `meta.can` e a
sua verificação de visibilidade sem efeitos secundários (`http:route-visibility`),
valida os requisitos de recurso no boot (`http:meta-validators`), e reclama a
chave `can` no check de guarded-meta que os adapters fazem no boot.

## Hooks — o rasto de auditoria

O Gate emite hooks `permission:*`, que o `auditPlugin` captura por omissão:

| Hook | Payload | Quando |
| --- | --- | --- |
| `permission:denied` | `{ userId, permission, scope }` | O `authorize()`, uma rota com `meta.can` ou uma audiência recusou o chamador |
| `permission:role_assigned` / `permission:role_removed` | `{ userId, role, scope }` | `gate.assignRole()` / `gate.removeRole()` |
| `permission:granted` | `{ role?, userId?, permissions, scope, expiresAt? }` | `gate.grantToRole()`, `gate.grantToUser()`, `gate.grantTemporarily()` |
| `permission:delegated` | `{ fromUserId, toUserId, permissions, scope, expiresAt? }` | `gate.delegate()` |

Altera as concessões através do Gate (`gate.assignRole(userId, role, scope?)`, …)
e não do store: escritas feitas diretamente no `AccessStore` não deixam rasto.

## Modos de falha e troubleshooting

| Erro | Código | HTTP | Quando |
| --- | --- | --- | --- |
| `PermissionDeniedError` | `PERMISSION_DENIED` | 403 | O check falhou — nada concede a permissão no scope atual nem no global |
| `AuthRequiredGuardError` | `AUTH_REQUIRED` | 401 | Uma rota com `meta.can` foi chamada sem utilizador autenticado no contexto (ou com um utilizador sem `id` de texto não vazio); também `can`/`authorize`/`hasRole` com esse utilizador |
| `ScopeRequiredError` | `PERMISSION_SCOPE_REQUIRED` | 400 | Uma escrita de concessões sem `scope`, sem tenant no contexto e com a tenancy ativa — passa o scope (ou `GLOBAL_SCOPE`) explicitamente |
| `InvalidCanMetaError` | `PERMISSION_META_INVALID` | 500 | O `meta.can` tem uma forma não aplicável (`true`, um número, um array vazio, uma entrada malformada) — falha fechada em cada pedido |
| `ResourceNotFoundError` | `RESOURCE_NOT_FOUND` | 404 | O loader de um requisito de recurso devolveu `null`/`undefined` (a menos que `notFound: 'deny'`) |
| `CanResourceUnavailableError` | `PERMISSION_RESOURCE_UNAVAILABLE` | 500 | `canResource()` chamado onde o guard não carregou recurso nenhum (ou vários, sem indicar a permissão) |
| `InvalidRouteMetaError` | `HTTP_INVALID_ROUTE_META` | boot | Um requisito de recurso está malformado, ou nenhuma política decide a sua permissão (com `onMissingPolicy: 'error'`) |
| `ReservedScopeError` | `PERMISSION_SCOPE_RESERVED` | 403 | O id de tenant do pedido é um scope reservado (`'@global'` ou `'global'`), ou o tenant não tem id utilizável |
| `MissingPolicyError` | `PERMISSION_POLICY_MISSING` | 500 | O `can`/`authorize` recebeu um recurso mas nenhum check de política corresponde a `resource:action` — a regra ABAC que pretendias seria saltada |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | boot | Uma rota declara `meta.can` (ou `auth`/`teamRole`/`scopes`/`subscribed`/`feature`) e nenhum guard registado reclama essa chave |

- **`PERMISSION_DENIED` para um utilizador que "tem o role"** — verifica o
  *scope*: um role atribuído no tenant `acme` não se aplica em `globex` nem
  globalmente. Atribui em `GLOBAL_SCOPE` para staff cross-tenant. Se o *role* é
  por tenant (teams) mas as permissões só foram concedidas em `GLOBAL_SCOPE`,
  usa `roleCatalog` ou `inheritGlobalRolePermissions` — vê
  [Um catálogo de roles para todos os tenants](#um-catalogo-de-roles-para-todos-os-tenants).
- **`PERMISSION_POLICY_MISSING` depois de um upgrade** — essa chamada
  `can(user, perm, resource)` já estava a responder silenciosamente a partir do
  RBAC. Confere a escrita das duas metades de `resource:action` contra o
  `definePolicy`, regista o check em falta, ou — se aquela chamada é mesmo RBAC
  simples — deixa de passar o recurso. `onMissingPolicy: 'rbac'` repõe o
  comportamento antigo por completo.
- **Um check de política parece ignorado** — a política só corre quando um
  *recurso* é passado a `can`/`authorize`; `can(user, 'project:update')` sem
  recurso — e um `meta.can: 'project:update'` simples — é RBAC puro por design e
  nunca consulta uma política. Declara o recurso na rota
  ([Políticas no guard](#politicas-no-guard-requisitos-de-recurso)).
- **`HTTP_UNGUARDED_ROUTE_META` no boot** — regista o `permissionsPlugin` ou,
  se a autorização acontece genuinamente numa edge exterior, opta por sair
  explicitamente com a opção do adapter `allowUnguardedMeta: true` (ou
  `['can']`). Vê o [guia de adapters](/pt/guide/adapters) e o
  [guia de segurança](/pt/guide/security).
