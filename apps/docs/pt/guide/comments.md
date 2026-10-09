# Comentários

`@basaltkit/comments` adiciona comentários em thread a **qualquer recurso** — uma
nota, um projeto, uma tarefa — com @mentions e resolve/reopen, delimitados por
tenant. Emite eventos que fazem ponte de forma limpa com o [realtime](/pt/guide/realtime)
(discussão ao vivo) e as notificações (alertar os mencionados).

[[toc]]

## Setup

Regista `commentsPlugin` e monta as rotas REST já prontas através do teu adaptador.
Em dev o store é em memória; em produção passa um `store` suportado por
`@basaltkit/comments-prisma` ou `-sqlite`:

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { COMMENTS, commentsPlugin, commentRoutes } from '@basaltkit/comments'

export const app = await createApp({
  plugins: [
    fastifyPlugin({ routes: [...commentRoutes()] }), // create/list/edit/delete/resolve/reopen
    commentsPlugin(),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
```

::: tip Dica
`add` extrai as mentions com `DEFAULT_MENTION_PATTERN` — `@id` (`[\w-]+`) não
precedido de um carácter de palavra, `.`, `+` ou `-`, por isso `ana@example.com`
**não** é uma mention de `example`. Passa `mentionPattern` (uma regex `g` cujo
primeiro grupo de captura é o user id) ao `commentsPlugin` para corresponder ao
teu próprio esquema de ids; `DELIMITED_MENTION_PATTERN` lê `@{qualquer-id}` para
ids com pontos ou `@`.
:::

## Adicionar e ler

```ts
import { COMMENTS } from '@basaltkit/comments'
const comments = app.container.get(COMMENTS)

const root = await comments.on('note', 'note-1').add({ authorId: 'u1', body: 'Nice work @u2!' })
await comments.on('note', 'note-1').add({ authorId: 'u2', body: 'Thanks!', parentId: root.id })

const tree = await comments.on('note', 'note-1').tree() // nested replies
```

`add` extrai as @mentions do corpo (padrão configurável), armazena-as no
comentário, e emite `comment:created` mais um `comment:mentioned` por cada
utilizador mencionado. Também: `edit`, `remove`, `resolve(id, by)`, `reopen(id)` —
e, opt-in, [âncoras, soft delete, janela de edição e revisões](#ancoras-soft-delete-janela-de-edicao-e-revisoes).

::: warning Corpos e mentions limitados
Um corpo maior que `maxBodyLength` (predefinição **10 000** caracteres) lança
`CommentTooLongError` (`400 COMMENT_TOO_LONG`), e um com mais de `maxMentions`
mentions distintas (predefinição **50**) lança `CommentMentionLimitError`
(`400 COMMENT_TOO_MANY_MENTIONS`) — em `add` e em `edit`, antes de guardar ou
emitir o que quer que seja. De resto cada `@id` é aceite tal como vem, por isso
quando `comment:mentioned` chega a um canal de notificação real, passa
`resolveMentions(ids, tenantId)` para manter só os utilizadores que podem ser
mencionados — tipicamente os membros do tenant:

```ts
commentsPlugin({
  resolveMentions: async (ids, tenantId) => (await members.of(tenantId, ids)).map((m) => m.userId),
})
```
:::

Dentro de um contexto de tenant, um argumento `tenantId` explícito tem de nomear
esse tenant; qualquer outro valor lança `CommentTenantMismatchError` (`403
COMMENT_TENANT_MISMATCH`). Só escolhe um tenant fora de um (jobs, CLI).

Numa app **single-tenant** — sem `tenancyPlugin` — as chamadas não precisam de
`tenantId`, e os comentários ficam numa única chave interna,
`SINGLE_TENANT_SCOPE` (`'@single'` — fora da gramática de ids de tenant, logo
nenhum tenant pode receber esses comentários). Um id de tenant igual a ela é
recusado com `CommentTenantReservedError` (`400 COMMENT_TENANT_RESERVED`).

::: warning Atualizar dados single-tenant
Antes do `@basaltkit/comments` 4.0 a chave single-tenant era `'default'` — um id
de tenant válido, logo um tenant chamado `default` lia, editava e apagava os
comentários single-tenant. Uma app single-tenant com comentários persistidos
muda-lhes a chave uma vez:
`UPDATE comments SET "tenantId" = '@single' WHERE "tenantId" = 'default'`
(`@basaltkit/comments-prisma`; no `@basaltkit/comments-sqlite` a coluna é
`tenant_id`). Salta este passo se `default` alguma vez foi um tenant real nessa
base de dados.
:::

## Discussão ao vivo + notificações de mention

Cada mutação emite um hook (`comment:created`, `comment:mentioned`,
`comment:updated`, `comment:deleted`, `comment:resolved`, `comment:reopened`),
por isso atualizações ao vivo e notificações ligam-se sem acoplamento. Cada
payload leva `actorId` — quem o fez: o autor em `created`/`mentioned`, quem
resolveu em `resolved`, senão o ator explícito (`edit(id, body, { actorId })`,
`remove(id, { by })`) ou `ctx().user.id`; só falta quando uma chamada corre fora
de um pedido sem ator indicado. Subscreve em `app.hooks`:

```ts
import { REALTIME } from '@basaltkit/realtime'
import { NOTIFIER, defineNotification } from '@basaltkit/notifications'
import { z } from 'zod'
import { app } from './app.js'

const realtime = app.container.get(REALTIME)
const notifier = app.container.get(NOTIFIER)

const CommentMention = defineNotification({
  name: 'comment.mention',
  schema: z.object({ by: z.string() }),
  channels: ['inApp'],
  via: { inApp: ({ by }) => ({ title: 'You were mentioned', data: { by } }) },
})

// push new comments to everyone viewing the resource
app.hooks.on('comment:created', ({ comment }) =>
  realtime
    .to(comment.tenantId)
    .channel(`${comment.resourceType}:${comment.resourceId}`)
    .emit('comment', comment))

// notify the mentioned — one hook fires per mentioned user
app.hooks.on('comment:mentioned', ({ comment, userId }) =>
  notifier.notify({ id: userId }, CommentMention, { by: comment.authorId }))
```

Os hooks são em processo. Para pôr a atividade dos comentários no bus durável
[`@basaltkit/events`](/pt/guide/queues) (outbox, listeners em fila), faz a ponte
dos que precisares:

```ts
import { EVENTS, defineEvent } from '@basaltkit/events'

const CommentCreated = defineEvent<{ commentId: string; actorId?: string }>('comment.created')
app.hooks.on('comment:created', ({ comment, actorId }) =>
  app.container.get(EVENTS).emit(CommentCreated, { commentId: comment.id, ...(actorId ? { actorId } : {}) }))
```

## Âncoras, soft delete, janela de edição e revisões

Tudo opt-in; sem estas opções os comentários comportam-se exatamente como antes.

```ts
commentsPlugin({
  deletion: 'soft',          // remove() guarda uma lápide em vez de apagar a linha
  editWindowMs: 15 * 60_000, // edit() recusado com 409 passados 15 minutos
  revisions: true,           // edit() guarda cada corpo anterior
})

// anchor: onde no recurso o comentário aponta (objeto JSON, ≤ 4 KB)
await comments.on('contract', 'c-12').add({ authorId: 'u1', body: 'Vê esta cláusula', anchor: { page: 3, rect: [72, 540, 300, 560] } })

await comments.remove(id, { by: 'moderator-1', reason: 'fora do tema' })
await comments.revisions(id) // [{ body, at, by }, …] do mais antigo para o mais recente
```

| Opção | Predefinição | Comportamento |
| --- | --- | --- |
| `deletion` | `'hard'` | `'soft'` define `deletedAt`/`deletedBy`/`deleteReason`; `list()`/`tree()` devolvem o comentário como **lápide** (`body` vazio, sem `mentions`) para as respostas manterem o seu lugar. `get()` continua a devolver o registo guardado (moderação). Um comentário soft-deleted responde 404 a edit/resolve/reopen; removê-lo de novo não faz nada. `comment:deleted` leva `soft: true` |
| `editWindowMs` | nenhuma | `edit()` fora da janela lança `CommentEditWindowClosedError` (`409 COMMENT_EDIT_WINDOW_CLOSED`) |
| `revisions` | `false` | `edit()` regista o corpo anterior (`CommentRevision`) antes de o substituir. Requer uma store com `addRevision`/`revisions` (memória, SQLite, Prisma); caso contrário a app **falha no arranque** com `CommentRevisionsUnsupportedError` |

`anchor` tem de ser um objeto JSON simples de no máximo 4 KB (`400
COMMENT_ANCHOR_INVALID`); `POST /comments` aceita-o no corpo. O schema Prisma
ganhou as colunas opcionais `anchor`, `deletedAt`, `deletedBy`, `deleteReason` e
um modelo `CommentRevision` — só são escritas quando usas a funcionalidade, por
isso adiciona-as antes de a ligar. O SQLite migra-se sozinho.

### Recusar mentions desconhecidas

`resolveMentions` filtra em silêncio. Para **recusar** um comentário que menciona
alguém que não pode ser mencionado, lança a partir dele — o erro propaga-se para
fora de `add`/`edit` (e pelas rotas, com o seu próprio status) antes de qualquer
coisa ser guardada:

```ts
commentsPlugin({
  resolveMentions: async (ids, tenantId) => {
    const known = new Set((await members.of(tenantId, ids)).map((m) => m.userId))
    const unknown = ids.filter((id) => !known.has(id))
    if (unknown.length) throw new HttpError(422, 'UNKNOWN_MENTION', `Utilizadores desconhecidos: ${unknown.join(', ')}`)
    return ids
  },
})
```

## Rotas

`commentRoutes()` (exigem um utilizador autenticado; o autor é tirado de
`ctx().user`): `GET /comments?resourceType=&resourceId=`, `POST /comments`,
`PATCH /comments/:id`, `DELETE /comments/:id`,
`POST /comments/:id/resolve` e `/reopen`. Por predefinição qualquer utilizador
do tenant pode ler uma thread e publicar nela, e editar, apagar, resolver e
reabrir estão restritos ao autor do comentário (`403 COMMENT_FORBIDDEN`). Tudo é
delimitado por tenant.

Passa `authorize` para ligar uma thread às regras de acesso do recurso que
discute. Substitui a política predefinida; compõe com `defaultCommentPolicy`
para a manter:

```ts
import { commentRoutes, defaultCommentPolicy } from '@basaltkit/comments'

commentRoutes({
  // action: 'list' | 'create' | 'edit' | 'delete' | 'resolve' | 'reopen'
  // target: { resourceType, resourceId, comment? }
  authorize: async (action, target, user) =>
    (await canSeeMatter(user.id, target.resourceId)) &&
    (defaultCommentPolicy(action, target, user) || (action === 'resolve' && user.role === 'admin')),
})
```

Para responder **404** em vez de 403 a um recurso cuja existência quem chama nem
deve conhecer, lança `CommentNotFoundError` a partir do `authorize` — o status do
erro chega ao cliente em todos os adaptadores:

```ts
import { CommentNotFoundError, commentRoutes } from '@basaltkit/comments'

commentRoutes({
  authorize: async (action, target, user) => {
    if (!(await canSeeMatter(user.id, target.resourceId))) throw new CommentNotFoundError() // 404 COMMENT_NOT_FOUND
    return defaultCommentPolicy(action, target, user)
  },
  meta: { can: 'comments:write' }, // meta de rota extra, fundido em todas as rotas (auth: true mantém-se sempre)
})
```

Aqui não é preciso UI já pronta — os comentários renderizam inline na tua app —
mas o mesmo padrão autocontido alimenta o [visualizador de auditoria](/pt/reference/packages).
