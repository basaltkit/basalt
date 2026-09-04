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
| `meta.tenant` | `tenancyPlugin` ([guia de tenancy](/pt/guide/tenancy)) | `404 TENANCY_NOT_RESOLVED` |

O `meta.tenant` é o caso à parte: não é um guard mas um *requisito*, lido durante
a resolução do tenant, e funciona nos dois sentidos — `false` marca a rota como
central, `true` exige tenant mesmo quando o default da app está desligado. Por
isso não é abrangido pela verificação de arranque abaixo.

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
O `gate.hasRole(user, role)` responde diretamente sobre a posse de um role.

### Os wildcards correspondem segmento a segmento

Um padrão concedido é comparado com a permissão pedida **um segmento separado
por `:` de cada vez**, e o número de segmentos tem de coincidir:

```ts
'projects:*'  covers 'projects:delete'      // ✅ same depth, second segment wildcarded
'projects:*'  covers 'projects:read'        // ✅
'projects:*'  does NOT cover 'projects:delete:all' // ❌ 2 segments vs 3 — no match
'*'           covers everything             // ✅ the one exception: a super admin
```

Assim, uma concessão de dois níveis nunca absorve silenciosamente uma permissão
mais profunda e específica que adiciones mais tarde — concede `projects:*:*`
(ou a string exata) se quiseres o nível mais profundo. O `'*'` simples
corresponde a qualquer permissão, independentemente da profundidade.

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

Qualquer outra forma (`can: true`, um número, um array vazio ou misto) não é
aplicável e **falha fechada**: o guard lança `InvalidCanMetaError`
(`PERMISSION_META_INVALID`, HTTP 500) em cada pedido em vez de saltar o check
silenciosamente. E declarar `meta.can` sem registar o `permissionsPlugin` falha
no **boot** — vê o guia de adapters.

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

## Referência de opções

O `permissionsPlugin(options)` recebe as mesmas opções que `new Gate(options)`:

| Opção | Tipo | Omissão | Propósito |
| --- | --- | --- | --- |
| `store` | `AccessStore` | — (obrigatória) | Onde vivem roles/permissões — a tua base de dados em produção |
| `superAdmin` | `(user) => boolean \| Promise<boolean>` | — | Curto-circuita **todos** os checks para `true` quando devolve `true` (o `Gate::before` do Laravel) |
| `scope` | `() => string` | `ctx().tenant.id` ?? `GLOBAL_SCOPE` | Scope atual; os checks consultam-no mais o `GLOBAL_SCOPE` |
| `policies` | `Policy[]` | `[]` | Políticas de recurso registadas à partida (o mesmo que chamar `gate.register`) |
| `temporaryGrants` | `TemporaryGrantStore` | desligado | Ativa `grantTemporarily()` |
| `delegations` | `DelegationStore` | desligado | Ativa `delegate()` |
| `now` | `() => number` | `Date.now` | Relógio injetável (testes) |
| `onMissingPolicy` | `'error' \| 'rbac'` | `'error'` | O que `can(user, perm, resource)` faz quando nenhum check de política corresponde a `resource:action`: `'error'` lança `MissingPolicyError` (falha fechada), `'rbac'` volta às strings de permissão concedidas |

O plugin regista o Gate sob o token `GATE`, adiciona o guard do `meta.can` e
reclama a chave `can` no check de guarded-meta que os adapters fazem no boot.

## Modos de falha e troubleshooting

| Erro | Código | HTTP | Quando |
| --- | --- | --- | --- |
| `PermissionDeniedError` | `PERMISSION_DENIED` | 403 | O check falhou — nada concede a permissão no scope atual nem no global |
| `AuthRequiredGuardError` | `AUTH_REQUIRED` | 401 | Uma rota com `meta.can` foi chamada sem utilizador autenticado no contexto |
| `InvalidCanMetaError` | `PERMISSION_META_INVALID` | 500 | O `meta.can` tem uma forma não aplicável (`true`, um número, um array vazio/misto) — falha fechada em cada pedido |
| `MissingPolicyError` | `PERMISSION_POLICY_MISSING` | 500 | O `can`/`authorize` recebeu um recurso mas nenhum check de política corresponde a `resource:action` — a regra ABAC que pretendias seria saltada |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | boot | Uma rota declara `meta.can` (ou `auth`/`teamRole`/`scopes`/`subscribed`/`feature`) e nenhum guard registado reclama essa chave |

- **`PERMISSION_DENIED` para um utilizador que "tem o role"** — verifica o
  *scope*: um role atribuído no tenant `acme` não se aplica em `globex` nem
  globalmente. Atribui em `GLOBAL_SCOPE` para staff cross-tenant.
- **`PERMISSION_POLICY_MISSING` depois de um upgrade** — essa chamada
  `can(user, perm, resource)` já estava a responder silenciosamente a partir do
  RBAC. Confere a escrita das duas metades de `resource:action` contra o
  `definePolicy`, regista o check em falta, ou — se aquela chamada é mesmo RBAC
  simples — deixa de passar o recurso. `onMissingPolicy: 'rbac'` repõe o
  comportamento antigo por completo.
- **Um check de política parece ignorado** — a política só corre quando um
  *recurso* é passado a `can`/`authorize`; `can(user, 'project:update')` sem
  recurso é RBAC puro por design e nunca consulta uma política.
- **`HTTP_UNGUARDED_ROUTE_META` no boot** — regista o `permissionsPlugin` ou,
  se a autorização acontece genuinamente numa edge exterior, opta por sair
  explicitamente com a opção do adapter `allowUnguardedMeta: true` (ou
  `['can']`). Vê o [guia de adapters](/pt/guide/adapters) e o
  [guia de segurança](/pt/guide/security).
