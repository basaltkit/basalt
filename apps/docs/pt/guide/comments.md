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
`add` extrai as mentions com `@([\w-]+)` por defeito. Passa `mentionPattern` (uma
regex cujo primeiro grupo de captura é o user id) ao `commentsPlugin` para
corresponder ao teu próprio esquema de ids.
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
utilizador mencionado. Também: `edit`, `remove`, `resolve(id, by)`, `reopen(id)`.

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

## Discussão ao vivo + notificações de mention

Cada mutação emite um hook (`comment:created`, `comment:mentioned`,
`comment:updated`, `comment:deleted`, `comment:resolved`, `comment:reopened`),
por isso atualizações ao vivo e notificações ligam-se sem acoplamento. Subscreve
em `app.hooks`:

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

Aqui não é preciso UI já pronta — os comentários renderizam inline na tua app —
mas o mesmo padrão autocontido alimenta o [visualizador de auditoria](/pt/reference/packages).
