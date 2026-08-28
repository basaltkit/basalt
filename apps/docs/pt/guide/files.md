# Upload de ficheiros

`@basaltkit/files` é um pipeline de upload sobre [`@basaltkit/storage`](/pt/reference/packages):
valida o content type e o tamanho, impõe uma quota de armazenamento por tenant,
escreve os bytes delimitados por tenant, regista metadata e emite hooks para
processamento fora de banda (antivírus, thumbnails).

[[toc]]

## Setup

`filesPlugin` assenta sobre um disco de [`@basaltkit/storage`](/pt/guide/storage) —
regista primeiro um disco, depois aponta o `filesPlugin` para ele pelo nome (ou
passa uma instância `Disk`), e monta as rotas de leitura/gestão através do teu
adaptador:

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { storagePlugin } from '@basaltkit/storage'
import { FILES, filesPlugin, fileRoutes } from '@basaltkit/files'

export const app = await createApp({
  plugins: [
    storagePlugin({ default: 'uploads', disks: { uploads: { driver: 'local', root: './storage' } } }),
    fastifyPlugin({ routes: [...fileRoutes()] }), // GET /files, GET /files/:id, POST /files/:id/url, DELETE /files/:id
    filesPlugin({
      disk: 'uploads',                                   // a disk name or a Disk instance
      // Opcional — os uploads têm um limite de 25 MiB mesmo sem validate
      // (DEFAULT_MAX_FILE_SIZE); define o teu limite e uma allowlist:
      validate: { maxSize: 5_000_000, allowedTypes: ['image/*', 'application/pdf'] },
      maxTotalBytes: 1_000_000_000,                      // per-tenant quota (1 GB)
    }),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
```

## Upload

O upload é multipart (específico do adaptador), por isso lê os bytes no teu próprio
handler e entrega o `Buffer` a `FILES.upload` — validação, quota, armazenamento
delimitado por tenant, checksum e o hook `file:uploaded` são todos tratados por ti.
Com Fastify + `@fastify/multipart`:

```ts
import { FILES } from '@basaltkit/files'
import { ctx } from '@basaltkit/core'
import { app } from './app.js'

const files = app.container.get(FILES)
const fastify = app.container.get(FASTIFY)

fastify.post('/files/upload', async (request, reply) => {
  const part = await request.file()                       // @fastify/multipart
  const buffer = await part.toBuffer()
  const record = await files.upload(buffer, {
    name: part.filename,
    contentType: part.mimetype,
    uploadedBy: ctx().user?.id,                            // tenantId comes from ctx().tenant
  })
  return reply.code(201).send(record)                     // FileRecord
})
```

`upload` valida, verifica a quota, armazena os bytes **isolados por tenant**,
regista metadata (nome, tamanho, checksum SHA-256, quem fez upload) e emite
`file:uploaded`. Devolve o `FileRecord`.

## Quota

`maxTotalBytes` é um limite embutido por tenant. Para ligar o armazenamento a um
plano, liga `checkQuota` (lança para rejeitar) a `@basaltkit/subscriptions`:

```ts
filesPlugin({ disk: 'uploads', checkQuota: (tenantId, size) =>
  subscriptions.features(tenantId).consume('storage_bytes', size) })
```

## Hooks de pós-processamento

O padrão típico: em `file:uploaded`, despacha um job de fila que analisa ou
transforma o ficheiro, depois regista o resultado com `markScanned`:

```ts
import { defineJob } from '@basaltkit/queue'
import { FILES } from '@basaltkit/files'
import { app } from './app.js'

const files = app.container.get(FILES)

const ScanFile = defineJob<{ tenantId: string; id: string }>({
  name: 'files.scan',
  queue: 'files',
  async handle({ tenantId, id }) {
    const clean = await antivirus.check(/* … */)          // your scanner
    await files.markScanned(id, { clean }, tenantId)       // emits file:scanned
  },
})

// on upload, dispatch the scan job — no coupling to the upload path
app.hooks.on('file:uploaded', ({ file }) =>
  ScanFile.dispatch({ tenantId: file.tenantId, id: file.id }))
```

Também disponíveis: `download`, `temporaryUrl` (assinado), `get`/`list`, `delete`
(emite `file:deleted`). Erros: `FileTooLargeError` (413),
`FileTypeNotAllowedError` (415), `StorageQuotaExceededError` (402).

O acesso ao armazenamento corre no contexto do tenant resolvido, por isso os
ficheiros mantêm-se isolados mesmo quando `upload` é chamado a partir de um job
em background.
