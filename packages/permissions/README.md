# @machize/permissions

Autorização para aplicações Machize: papéis (roles), permissões com wildcards, políticas por recurso, super admin e proteção de rotas — ao estilo do Spatie Permissions do Laravel.

Precisas deste módulo quando diferentes utilizadores podem fazer coisas diferentes na tua aplicação (ex.: só administradores apagam projetos).

## O que este módulo resolve

Autenticação (saber *quem* é o utilizador) não chega: falta a **autorização** — decidir *o que* esse utilizador pode fazer. Escrever `if (user.isAdmin)` espalhado pelo código torna-se rapidamente incontrolável. Este módulo centraliza essas decisões num único sítio, o **Gate** ("portão"), a quem perguntas: "este utilizador pode `projects:delete`?".

Os blocos de construção são: **permissões** (etiquetas como `projects:delete`, com suporte a wildcards — `projects:*` cobre todas as ações de projetos e `*` cobre tudo), **papéis/roles** (conjuntos de permissões com nome, como `admin`, atribuídos a utilizadores), e **políticas** (regras contextuais sobre um recurso concreto, ex.: "só o dono do projeto pode editá-lo").

Tudo é **scoped por tenant** por omissão: uma permissão dada dentro do tenant "acme" não vale no tenant "globex". Grants no âmbito `global` valem em todo o lado. As atribuições vivem num `AccessStore` — em memória para desenvolvimento, na tua base de dados em produção.

## Instalação

```bash
pnpm add @machize/permissions
```

## Começar em 5 minutos

1. **Cria um store e concede permissões:**

```ts
import { Gate, MemoryAccessStore, GLOBAL_SCOPE } from '@machize/permissions'

const store = new MemoryAccessStore()

// O papel "admin" pode tudo em projetos e ler faturação (âmbito global)
await store.grantToRole('admin', ['projects:*', 'billing:read'], GLOBAL_SCOPE)

// A Ada é admin
await store.assignRole('user-ada', 'admin', GLOBAL_SCOPE)
```

2. **Cria o Gate e pergunta:**

```ts
const gate = new Gate({ store })

await gate.can({ id: 'user-ada' }, 'projects:delete') // true (via projects:*)
await gate.can({ id: 'user-ada' }, 'billing:write')   // false
await gate.hasRole({ id: 'user-ada' }, 'admin')       // true
```

3. **Ou exige a permissão (lança erro 403 se faltar):**

```ts
await gate.authorize({ id: 'user-ada' }, 'projects:delete') // ok
await gate.authorize({ id: 'outro' }, 'projects:delete')    // lança PermissionDeniedError
```

4. **Numa aplicação HTTP, protege rotas com `meta.can`:**

```ts
import { createApp } from '@machize/core'
import { fastifyPlugin, route } from '@machize/fastify'
import { permissionsPlugin, MemoryAccessStore } from '@machize/permissions'

const store = new MemoryAccessStore()
await store.grantToUser('user-ada', ['projects:delete'], 'global')

const app = await createApp({
  plugins: [
    // ... plugin de autenticação que define ctx().user (ex.: @machize/auth)
    permissionsPlugin({ store }),
    fastifyPlugin({
      routes: [
        route({
          method: 'DELETE',
          url: '/projects/:id',
          meta: { can: 'projects:delete' }, // sem a permissão → 403
          async handler() { return { deleted: true } },
        }),
      ],
    }),
  ],
}).boot()
```

Sem utilizador autenticado a rota devolve 401 (`AUTH_REQUIRED`); com utilizador sem a permissão devolve 403 (`PERMISSION_DENIED`).

## Guia de utilização

### Permissões com wildcards

Uma permissão é uma string; por convenção `recurso:ação`. A correspondência é feita por `permissionMatches(concedida, pedida)`:

- `projects:delete` cobre exatamente `projects:delete`;
- `projects:*` cobre `projects:delete`, `projects:read`, … (mas **não** `projects:sub:deep` — o número de segmentos tem de coincidir);
- `*` cobre tudo.

### Papéis (roles)

Um papel agrupa permissões e é atribuído a utilizadores dentro de um âmbito (scope):

```ts
import { MemoryAccessStore } from '@machize/permissions'

const store = new MemoryAccessStore()
await store.grantToRole('editor', ['articles:read', 'articles:write'], 'acme')
await store.assignRole('user-bob', 'editor', 'acme') // só vale no tenant acme
await store.removeRole('user-bob', 'editor', 'acme')
```

Também podes dar permissões diretamente a um utilizador com `grantToUser(userId, permissions, scope)`.

### Âmbito por tenant (scope)

Quando o Gate verifica, procura os grants em **dois** âmbitos: o âmbito atual e o `GLOBAL_SCOPE` (`'global'`). O âmbito atual, por omissão, é o `ctx().tenant.id` definido pelo `@machize/tenancy` — ou `global` se não houver tenant. Podes substituir com a opção `scope`:

```ts
import { Gate, MemoryAccessStore } from '@machize/permissions'

const gate = new Gate({
  store: new MemoryAccessStore(),
  scope: () => 'o-meu-ambito', // avançado: âmbito personalizado
})
```

### Políticas (regras sobre um recurso concreto)

Uma **política** decide olhando para o objeto em causa — por exemplo, "só o dono edita". Quando chamas `can()` com um terceiro argumento (o recurso) e existe uma política para `recurso:ação`, é a política que decide (os grants não são consultados):

```ts
import { Gate, MemoryAccessStore, definePolicy } from '@machize/permissions'

interface Project { ownerId: string }

const ProjectPolicy = definePolicy<Project>('project', {
  update: (user, project) => project.ownerId === user.id,
})

const gate = new Gate({ store: new MemoryAccessStore(), policies: [ProjectPolicy as never] })
// ou depois: gate.register(ProjectPolicy as never)

await gate.can({ id: 'u9' }, 'project:update', { ownerId: 'u9' })    // true
await gate.can({ id: 'u9' }, 'project:update', { ownerId: 'outro' }) // false
```

### Super admin

Uma função que, quando devolve `true` para um utilizador, autoriza tudo (equivalente ao `Gate::before` do Laravel):

```ts
import { Gate, MemoryAccessStore } from '@machize/permissions'

const gate = new Gate({
  store: new MemoryAccessStore(),
  superAdmin: (user) => user['owner'] === true,
})

await gate.can({ id: 'x', owner: true }, 'qualquer:coisa') // true, sempre
```

### Usar o Gate dentro de handlers

O plugin regista o Gate no container sob o token `GATE`:

```ts
import { ctx, type Container } from '@machize/core'
import { GATE } from '@machize/permissions'

const gate = (ctx().container as Container).get(GATE)
await gate.authorize(ctx().user!, 'billing:write')
```

## Referência da API

### `Gate` / `permissionsPlugin(options)`

Opções (`GateOptions` = `PermissionsPluginOptions`):

| Nome | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `store` | `AccessStore` | Sim | — | Onde vivem os grants (a tua BD em produção). |
| `superAdmin` | `(user) => boolean \| Promise<boolean>` | Não | — | Curto-circuito: `true` autoriza tudo. |
| `scope` | `() => string` | Não | `ctx().tenant.id` ou `'global'` | Âmbito atual das verificações. |
| `policies` | `Policy<never>[]` | Não | `[]` | Políticas registadas à partida. |

Métodos do `Gate`:

| Método | Devolve | Descrição |
|---|---|---|
| `can(user, permission, resource?)` | `Promise<boolean>` | Verifica; com recurso e política aplicável, a política decide. |
| `authorize(user, permission, resource?)` | `Promise<void>` | Como `can`, mas lança `PermissionDeniedError` (403). |
| `hasRole(user, role)` | `Promise<boolean>` | O utilizador tem o papel (no âmbito atual ou global)? |
| `register(policy)` | `this` | Regista uma política depois da construção. |

### Interface `AccessStore`

Implementa isto sobre a tua base de dados. `scope` é o id do tenant ou `GLOBAL_SCOPE`:

| Método | Descrição |
|---|---|
| `getUserRoles(userId, scope)` | Papéis do utilizador no âmbito. |
| `getUserPermissions(userId, scope)` | Permissões diretas do utilizador. |
| `getRolePermissions(role, scope)` | Permissões de um papel. |
| `assignRole(userId, role, scope)` / `removeRole(...)` | Atribuir/retirar papel. |
| `grantToRole(role, permissions, scope)` | Dar permissões a um papel. |
| `grantToUser(userId, permissions, scope)` | Dar permissões diretas. |

`MemoryAccessStore` é a implementação em memória (dev/testes).

### Outros exports

| Export | Descrição |
|---|---|
| `permissionMatches(granted, requested)` | Correspondência com wildcards. |
| `definePolicy<T>(resource, checks)` | Cria uma `Policy<T>` (checks: `(user, resource) => boolean \| Promise<boolean>`). |
| `GLOBAL_SCOPE` | A string `'global'`. |
| `GATE` | Token de injeção do Gate no container. |
| `PolicyUser` | Tipo mínimo de utilizador: `{ id: string; [key: string]: unknown }`. |
| `Policy`, `PolicyCheck` | Tipos das políticas. Avançado. |
| `PermissionDeniedError` | `PERMISSION_DENIED`, HTTP 403. |
| `AuthRequiredGuardError` | `AUTH_REQUIRED`, HTTP 401 — rota `meta.can` sem utilizador. |

### Guard de rotas

O `permissionsPlugin` regista um guard: qualquer rota com `meta: { can: 'alguma:permissao' }` exige um `ctx().user` (senão 401) com essa permissão (senão 403). O guard só aceita uma string única em `meta.can`.

## Erros comuns e soluções (FAQ)

**"403 PERMISSION_DENIED mas eu dei a permissão."** Verifica o **âmbito**: um grant no scope `'acme'` só vale quando o pedido corre no tenant `acme`. Se queres que valha em todo o lado, usa `GLOBAL_SCOPE`.

**"401 AUTH_REQUIRED numa rota com meta.can."** O guard precisa de `ctx().user` — regista antes um plugin de autenticação (ex.: `@machize/auth`) e envia credenciais no pedido.

**"`projects:*` não cobre `projects:sub:deep`."** Intencional: o wildcard cobre um segmento; o número de segmentos tem de coincidir. Usa `projects:sub:*` ou `*`.

**"A política não é chamada."** A política só decide quando passas o **recurso** como terceiro argumento de `can`/`authorize`, e o nome da permissão tem de ser `recurso:ação` com o mesmo nome de recurso da política. O guard `meta.can` não passa recursos — para políticas, chama o Gate dentro do handler.

**"Os grants desaparecem ao reiniciar."** `MemoryAccessStore` vive em memória. Implementa `AccessStore` sobre a tua base de dados.

## Como se liga aos outros módulos

- **@machize/auth** — autentica e define `ctx().user`, que o guard `meta.can` consome. Auth = quem és; permissions = o que podes.
- **@machize/tenancy** — define `ctx().tenant`; o Gate usa-o como âmbito por omissão, isolando permissões por tenant.
- **@machize/teams** — pode espelhar as pertenças de equipa como papéis: o `MemoryAccessStore` (ou o teu `AccessStore`) satisfaz a interface `RoleAssigner` do teams, e assim "ser admin da equipa acme" torna-se automaticamente o papel `admin` no scope `acme`.
- **@machize/core / @machize/fastify** — container, contexto e execução dos guards HTTP.
