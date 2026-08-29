# Autorização (permissions)

A autenticação diz-te *quem* é o utilizador; o
[`@basaltkit/permissions`](/reference/packages/permissions) decide *o que* ele pode
fazer. Centraliza essas decisões num **Gate** a quem perguntas "este utilizador pode
fazer `projects:delete`?" — com roles, permissões wildcard e políticas de recurso,
tudo **scoped por tenant** por omissão.

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

Os wildcards compõem: `projects:*` cobre toda a ação de projeto, `*` cobre tudo (um
super admin). O `gate.authorize(user, perm)` é a variante que lança — levanta um erro
estilo 403 em vez de devolver `false`.

## Políticas de recurso

Para regras que dependem do recurso *específico* — "só o dono do projeto o pode
editar" — regista uma política:

```ts
import { definePolicy } from '@basaltkit/permissions'

const ProjectPolicy = definePolicy<Project>({
  name: 'projects:edit',
  check: (user, project) => project.ownerId === user.id,
})

gate.register(ProjectPolicy)
await gate.can({ id: 'u1' }, 'projects:edit', project) // corre a política com o recurso
```

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

## Scoping por tenant

As concessões são **por tenant** por omissão: `projects:*` concedido em `acme` não se
aplica em `globex`. Usa `GLOBAL_SCOPE` para concessões que se aplicam em todo o lado.
Há também [concessões temporárias e delegação](/reference/packages/permissions) — um
utilizador pode emprestar um subconjunto das suas próprias permissões diretas a outro
por um tempo limitado. Em produção, troca o `MemoryAccessStore` por um `AccessStore`
durável (variantes Prisma/SQLite no ecossistema).
