# @machize/comments

Comentários por recurso para o Machize: **threads** (respostas aninhadas), **@menções** e **resolver/reabrir**, isolados por tenant, emitindo **eventos** que se ligam ao [`@machize/realtime`](https://www.npmjs.com/package/@machize/realtime) (discussão ao vivo) e ao [`@machize/notifications`](https://www.npmjs.com/package/@machize/notifications) (avisar quem foi mencionado). Precisas deste módulo quando queres colaboração — comentar uma nota, um projeto, uma tarefa.

## O que este módulo resolve

Um sistema de comentários envolve mais do que guardar texto: threads com respostas, extrair @menções para notificar, marcar uma discussão como resolvida, e restringir edições ao autor. Este módulo dá-te tudo isso — associado a **qualquer recurso** (`resourceType`:`resourceId`) e isolado por tenant — e emite eventos para o resto do ecossistema reagir.

## Instalação

```bash
pnpm add @machize/comments
```

Depende do `@machize/core` e `@machize/fastify` (rotas). Sem base de dados: o store por omissão é em memória (contrato `CommentStore` para produção).

## Começar em 5 minutos

```ts
import { createApp } from '@machize/core'
import { commentsPlugin, COMMENTS, commentRoutes } from '@machize/comments'
import { fastifyPlugin } from '@machize/fastify'

const app = await createApp({
  plugins: [commentsPlugin(), fastifyPlugin({ routes: [...commentRoutes()] })],
}).boot()

const comments = app.container.get(COMMENTS)

// adicionar um comentário a um recurso
const root = await comments.on('note', 'note-1', 'acme').add({ authorId: 'u1', body: 'Ótimo trabalho @u2!' })

// responder (thread)
await comments.on('note', 'note-1', 'acme').add({ authorId: 'u2', body: 'Obrigado!', parentId: root.id })

// obter a árvore de comentários
const tree = await comments.on('note', 'note-1', 'acme').tree()
```

`add` extrai as @menções do corpo (por omissão `@id`), guarda-as no comentário e emite `comment:mentioned` por cada utilizador mencionado.

## Ligar ao realtime e às notificações

O poder está nos eventos. Empurra comentários ao vivo e notifica os mencionados sem acoplar nada:

```ts
// discussão ao vivo (realtime)
hooks.on('comment:created', ({ comment }) =>
  realtime.to(comment.tenantId).channel(`${comment.resourceType}:${comment.resourceId}`).emit('comment', comment))

// notificar quem foi mencionado
hooks.on('comment:mentioned', ({ comment, userId }) =>
  notifications.to(userId).send('comment.mention', { by: comment.authorId, resource: comment.resourceId }))
```

## Rotas

`commentRoutes()` (todas exigem login; autor vem de `ctx().user`):

| Rota | Descrição |
|---|---|
| `GET /comments?resourceType=&resourceId=` | Árvore de comentários do recurso. |
| `POST /comments` `{ resourceType, resourceId, body, parentId? }` | Cria (ou responde). |
| `PATCH /comments/:id` `{ body }` | Edita — **só o autor**. |
| `DELETE /comments/:id` | Apaga — **só o autor**. |
| `POST /comments/:id/resolve` · `/reopen` | Resolve / reabre a discussão. |

## Referência da API

### `commentsPlugin({ store?, mentionPattern? })`

Regista o token `COMMENTS`. `mentionPattern` é uma regex cujo primeiro grupo é o id mencionado (default `@([\w-]+)`).

### `class Comments`

| Método | Descrição |
|---|---|
| `on(resourceType, resourceId, tenantId?)` | `{ add, list, tree }` para um recurso. |
| `get(id, tenantId?)` | Um comentário. |
| `edit(id, body, tenantId?)` | Edita e re-extrai menções; emite `comment:updated`. |
| `remove(id, tenantId?)` | Apaga; emite `comment:deleted`. |
| `resolve(id, by, tenantId?)` · `reopen(id, tenantId?)` | Emite `comment:resolved` / `comment:reopened`. |

Sem `tenantId`, usa `ctx().tenant.id` (senão `CommentTenantRequiredError`).

### Eventos

`comment:created` · `comment:updated` · `comment:deleted` · `comment:resolved` · `comment:reopened` · `comment:mentioned` (um por utilizador mencionado).

## Como se liga aos outros módulos

- **`@machize/realtime`** — empurra `comment:created` para o canal do recurso (discussão ao vivo).
- **`@machize/notifications`** — reage a `comment:mentioned` para avisar os mencionados.
- **`@machize/auth` / `@machize/tenancy`** — fornecem o utilizador (autor) e o tenant do contexto.
