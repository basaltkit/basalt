# Upload de ficheiros

`@basaltkit/files` é o pipeline de upload que assenta sobre
[`@basaltkit/storage`](/pt/guide/storage): valida o content type e o tamanho,
impõe uma quota por tenant, escreve os bytes delimitados por tenant, regista a
metadata e emite hooks para que a análise e as miniaturas aconteçam fora de
banda. Está desacoplado do transporte — o parsing multipart fica no teu handler
— e do backend, porque cada byte passa por um `Disk` de armazenamento.

[[toc]]

## Modelo mental

Um ficheiro são **duas coisas que não devem ser confundidas**:

| Peça | Vive em | Pertence a |
| --- | --- | --- |
| Os **bytes** | um `Disk` de armazenamento (local, S3, GCS, Azure) em `files/<uuid>` | `@basaltkit/storage` |
| O **registo** (nome, tamanho, content type, SHA-256, quem carregou, resultado da análise) | um `FileStore` | `@basaltkit/files` |

`Files.upload()` é a única coisa que escreve ambos, por esta ordem: validar
tamanho → validar content type → verificar quota → escrever bytes → gravar
registo → emitir `file:uploaded`. Se a validação ou a quota rejeitarem, **nada é
escrito** — nem bytes nem registo.

Todas as operações são delimitadas por tenant. O tenant vem do argumento
explícito `tenantId`, ou de `ctx().tenant.id`, e não há terceira opção: sem
nenhum dos dois, a chamada lança `FileTenantRequiredError`
(`400 FILE_TENANT_REQUIRED`) em vez de cair para um namespace global. O acesso ao
armazenamento é depois embrulhado no contexto desse tenant, por isso o prefixo
`tenants/<id>/` do disco aplica-se mesmo quando o `upload` corre a partir de um
job em background sem pedido ambiente.

## Arranque rápido

O `filesPlugin` precisa de um disco. Regista primeiro o `storagePlugin`, aponta o
`filesPlugin` a um disco pelo nome (ou passa uma instância `Disk`) e monta as
rotas de leitura/gestão através do teu adaptador:

```ts
// src/app.ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin, FASTIFY } from '@basaltkit/fastify'
import { authPlugin, MemoryUserSource } from '@basaltkit/auth'
import { storagePlugin } from '@basaltkit/storage'
import { FILES, filesPlugin, fileRoutes } from '@basaltkit/files'

export const app = await createApp({
  plugins: [
    // ... o teu plugin de tenancy, que define ctx().tenant ...
    authPlugin({ users: new MemoryUserSource(), secret: process.env.AUTH_SECRET! }),
    storagePlugin({ default: 'uploads', disks: { uploads: { driver: 'local', root: './storage' } } }),
    filesPlugin({
      disk: 'uploads',                                   // um nome de disco ou uma instância Disk
      // Os uploads têm um limite de 25 MiB (DEFAULT_MAX_FILE_SIZE) mesmo sem
      // qualquer `validate`; define o teu limite e uma allowlist:
      validate: { maxSize: 5_000_000, allowedTypes: ['image/*', 'application/pdf'] },
      maxTotalBytes: 1_000_000_000,                      // quota por tenant (1 GB)
    }),
    fastifyPlugin({ routes: [...fileRoutes()] }),
  ],
}).boot()

await app.container.get(FASTIFY).listen({ port: 3000 })
```

Todas as rotas de `fileRoutes()` declaram `meta: { auth: true }`, por isso o
`authPlugin` tem de estar registado — caso contrário o adaptador recusa arrancar
com `UnguardedRouteMetaError` (`HTTP_UNGUARDED_ROUTE_META`) em vez de servir os
teus ficheiros sem autenticação. Vê o [guia de adaptadores](/pt/guide/adapters).

## Fazer upload

O parsing multipart é específico do adaptador, por isso lê os bytes no teu
próprio handler e entrega o `Buffer` a `FILES.upload`. Validação, quota,
armazenamento delimitado por tenant, o checksum e o hook `file:uploaded` são
todos tratados por ti. Com Fastify + `@fastify/multipart`:

```ts
import { FILES } from '@basaltkit/files'
import { FASTIFY } from '@basaltkit/fastify'
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
    uploadedBy: ctx().user?.id,                           // o tenantId vem de ctx().tenant
    metadata: { source: 'web' },                          // o que quiseres no registo
  })
  return reply.code(201).send(record)                     // FileRecord
})
```

O `FileRecord` devolvido é `{ id, tenantId, name, contentType, size, path,
checksum, uploadedBy?, metadata?, scanned?, createdAt }`. O `path` é a chave
**dentro do disco** (`files/<uuid>`); o disco acrescenta o prefixo do tenant em
todas as operações, por isso o objeto aterra realmente em
`tenants/<tenantId>/files/<uuid>`.

::: warning O `contentType` é a alegação do cliente
`allowedTypes` compara com o content type que passas, que num upload de browser é
o que o browser disser. Trava enganos honestos, não atacantes. Trata o sniffing
dos magic bytes, e a passagem de antivírus/moderação abaixo, como o controlo a
sério — e mantém a predefinição `attachment` dos URLs assinados (vê
[Armazenamento](/pt/guide/storage)) para que um HTML ou SVG mal rotulado não
possa renderizar na origem do armazenamento.
:::

### Limites de tamanho e de tipo

`validate.maxSize` tem por predefinição `DEFAULT_MAX_FILE_SIZE` — **25 MiB** — e
é aplicado mesmo quando não passas qualquer `validate`. Algo maior lança
`FileTooLargeError` (`413 FILE_TOO_LARGE`) antes de escrever um único byte:

```ts
import { DEFAULT_MAX_FILE_SIZE } from '@basaltkit/files'

filesPlugin({ disk: 'uploads', validate: { maxSize: 50 * 1024 * 1024 } })  // aumentar
filesPlugin({ disk: 'uploads', validate: { maxSize: Number.POSITIVE_INFINITY } }) // desligar
```

`allowedTypes` é uma allowlist com wildcard `type/*`: `['image/*',
'application/pdf']` aceita `image/png` e `application/pdf` e rejeita tudo o resto
com `FileTypeNotAllowedError` (`415 FILE_TYPE_NOT_ALLOWED`). Sem `allowedTypes`,
todos os content types são aceites.

O limite do pipeline é distinto do `maxBytes` / `allowedContentTypes` por `put`
da fachada de armazenamento — vê a
[referência de opções do armazenamento](/pt/guide/storage). Não precisas dos
dois; o `filesPlugin` é o sítio certo para a política de upload.

## Quotas

`maxTotalBytes` é o limite embutido por tenant. Antes de cada upload, o
`totalSize(tenantId)` do store é somado ao tamanho a entrar; acima da linha lança
`StorageQuotaExceededError` (`402 FILE_QUOTA_EXCEEDED`).

Para ligar o armazenamento a um plano, liga antes o `checkQuota` — um hook
assíncrono que lança para rejeitar — a
[`@basaltkit/subscriptions`](/pt/guide/billing):

```ts
filesPlugin({
  disk: 'uploads',
  checkQuota: (tenantId, size) =>
    subscriptions.features(tenantId).consume('storage_bytes', size),
})
```

Ambos correm quando ambos estão definidos: primeiro `maxTotalBytes`, depois
`checkQuota`. Nota que `consume()` **regista** o consumo, por isso um
`checkQuota` construído sobre ele tem de ser compensado libertando as unidades
quando um ficheiro é apagado (ouve `file:deleted`) — caso contrário a quota do
plano de um tenant só desce.

## Servir e descarregar

Três formas de devolver bytes a um cliente, por ordem de preferência:

```ts
// 1. Um URL assinado direto para o objeto — nenhum byte passa pela tua app.
const url = await files.temporaryUrl(id, '15m')

// 2. Os bytes, para ficheiros pequenos ou quando tens mesmo de fazer proxy.
const { record, content } = await files.download(id)

// 3. Só metadata.
const record = await files.get(id)          // FileRecord | null
const all = await files.list()              // FileRecord[] do tenant
```

`temporaryUrl` herda a predefinição do armazenamento: **`Content-Disposition:
attachment`**, para que um HTML ou SVG carregado nunca renderize ao nível de topo
na origem do armazenamento. Passa `{ disposition: 'inline' }` (quarto argumento)
quando a renderização no browser for deliberada — usos embebidos em
`<img>`/`<video>` renderizam de qualquer forma. A justificação completa está em
[Armazenamento](/pt/guide/storage).

```ts
await files.temporaryUrl(id, '15m', undefined, { disposition: 'inline' })
```

Os URLs assinados precisam de um driver que os suporte: `s3`, GCS e Azure
suportam, o driver `local` lança `TemporaryUrlUnsupportedError`
(`STORAGE_TEMPORARY_URL_UNSUPPORTED`). Em desenvolvimento local, faz proxy por
`files.download()`.

`files.delete(id)` remove o objeto e o registo e emite `file:deleted`. É
idempotente: apagar um id desconhecido é um no-op silencioso, nunca um 404.

## Hooks de pós-processamento

`file:uploaded` dispara depois de o registo ser gravado, por isso a resposta do
upload nunca espera pelo teu scanner. O padrão típico é despachar um job de fila
e registar o resultado com `markScanned`, que passa `scanned: true`, junta o
resultado a `metadata.scan` e emite `file:scanned`:

```ts
import { defineJob } from '@basaltkit/queue'
import { FILES } from '@basaltkit/files'
import { app } from './app.js'

const files = app.container.get(FILES)

const ScanFile = defineJob<{ tenantId: string; id: string }>({
  name: 'files.scan',
  queue: 'files',
  async handle({ tenantId, id }) {
    const { content } = await files.download(id, tenantId)  // tenant explícito: os jobs não têm ctx
    const clean = await antivirus.check(content)            // o teu scanner
    await files.markScanned(id, { clean }, tenantId)        // emite file:scanned
  },
})

// no upload, despacha o job de análise — sem acoplamento ao caminho do upload
app.hooks.on('file:uploaded', ({ file }) =>
  ScanFile.dispatch({ tenantId: file.tenantId, id: file.id }))
```

::: tip Passa o `tenantId` explicitamente nos jobs
Dentro de um pedido o tenant é lido de `ctx()`. Um worker de fila corre fora de
qualquer pedido, por isso passa o `tenantId` que puseste no payload do job — todos
os métodos de `Files` o aceitam como argumento opcional exatamente por isto. Sem
ele obténs `400 FILE_TENANT_REQUIRED`, não o ficheiro de outro tenant.
:::

As derivações (miniaturas, transcodificações) seguem a mesma forma, usando o
pipeline de imagem do armazenamento. Precisa de um `imageProcessor` —
`SharpImageProcessor` de `@basaltkit/image-sharp` — no `storagePlugin`, e as
operações de disco têm de correr no contexto do tenant do ficheiro:

```ts
import { runWithContext } from '@basaltkit/core'
import { STORAGE } from '@basaltkit/storage'

app.hooks.on('file:uploaded', async ({ file }) => {
  if (!file.contentType.startsWith('image/')) return
  const disk = app.container.get(STORAGE).disk('uploads')
  await runWithContext({ tenant: { id: file.tenantId } } as never, () =>
    disk.image(file.path).resize(256, 256).webp().save(`${file.path}-thumb.webp`))
})
```

Sem um processador configurado, o terminal do pipeline lança
`ImageProcessingUnavailableError` (`STORAGE_IMAGE_UNAVAILABLE`). Vê a
[secção do pipeline de imagem no guia de armazenamento](/pt/guide/storage).

## Rotas

`fileRoutes()` monta endpoints de leitura/gestão para os ficheiros do **tenant
atual**. São construídas sobre o `route()` neutro de `@basaltkit/http`, por isso
servem de forma idêntica em Fastify, Express e Hono. O upload não está entre
elas — multipart é específico do transporte, por isso escreves tu esse handler
(acima).

| Rota | Corpo | Devolve |
| --- | --- | --- |
| `GET /files` | — | `FileRecord[]` do tenant |
| `GET /files/:id` | — | um `FileRecord`, ou `404 FILE_NOT_FOUND` |
| `POST /files/:id/url` | `{ expiresIn? }` (predefinição `'15m'`) | `{ url }` — assinado, `attachment` |
| `DELETE /files/:id` | — | `204`, idempotente |

::: danger Autenticação não é autorização de tenant
Todas as rotas declaram `meta: { auth: true }`, o que prova *quem* está a chamar.
**Não** prova que quem chama pertence ao tenant que o pedido resolveu — o tenant
vem de um header ou de um `Host`, ambos controlados pelo cliente. Regista o
[`tenantMembershipPlugin()`](/pt/guide/teams) para que um utilizador válido do
tenant A a enviar o identificador do tenant B seja travado com
`403 TEAM_NOT_A_MEMBER` antes de correr qualquer código de ficheiros. Sem ele,
`GET /files` lista o tenant que o pedido alegar.
:::

## Guardar metadata de forma durável

O `FileStore` por predefinição é o `MemoryFileStore` — por processo, perdido no
restart, e os bytes passam então a sobreviver aos registos que apontam para eles.
**Não existe pacote `files-sqlite` / `files-prisma`**: a metadata de ficheiros
pertence ao teu próprio schema, ao lado das linhas de domínio que a referenciam.
O contrato tem seis métodos:

```ts
import type { FileStore, FileRecord, FilePatch } from '@basaltkit/files'

class PrismaFileStore implements FileStore {
  constructor(private readonly prisma: PrismaClient) {}
  async create(record: FileRecord) { await this.prisma.file.create({ data: record }) }
  async find(tenantId: string, id: string) { return this.prisma.file.findFirst({ where: { tenantId, id } }) }
  async list(tenantId: string) { return this.prisma.file.findMany({ where: { tenantId } }) }
  async update(tenantId: string, id: string, patch: FilePatch) {
    return this.prisma.file.update({ where: { id }, data: patch })
  }
  async delete(tenantId: string, id: string) { await this.prisma.file.deleteMany({ where: { tenantId, id } }) }
  async totalSize(tenantId: string) {
    const { _sum } = await this.prisma.file.aggregate({ _sum: { size: true }, where: { tenantId } })
    return _sum.size ?? 0
  }
}

filesPlugin({ disk: 'uploads', store: new PrismaFileStore(prisma) })
```

Todos os métodos recebem o `tenantId` — mantém-no na cláusula `where` de todos
eles. `totalSize` é o caminho quente da quota, por isso indexa `(tenantId)`. Vê
[Persistência](/pt/guide/persistence).

## Referência de opções

### `filesPlugin(options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `disk` | `Disk \| string` | — (obrigatório) | O disco de armazenamento, por instância ou pelo nome declarado em `storagePlugin({ disks })`. Um nome desconhecido lança `UnknownDiskError` quando `FILES` é resolvido pela primeira vez |
| `store` | `FileStore` | `MemoryFileStore` | Onde vive a metadata — implementa-o sobre a tua base de dados em produção, ou os registos desaparecem no restart |
| `validate` | `FileValidation` | `{ maxSize: 25 MiB }` | Política de upload (abaixo). Passar `validate` **funde** com o limite predefinido; não o remove |
| `maxTotalBytes` | `number` | ilimitado | Quota embutida por tenant, verificada contra `store.totalSize()` antes de cada upload |
| `checkQuota` | `(tenantId, size) => void \| Promise<void>` | — | Quota personalizada — lança para rejeitar. Liga-a a uma feature de plano em `@basaltkit/subscriptions`. Corre *depois* de `maxTotalBytes` |

O serviço `Files` aceita as mesmas opções mais `hooks` (o `HookBus`, injetado
pelo plugin) e `now` (um relógio injetável para testes); constrói-o diretamente
com `new Files({ disk, ... })` quando quiseres o pipeline sem o contentor de DI.

### `FileValidation` (a opção `validate`)

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `maxSize` | `number` (bytes) | `DEFAULT_MAX_FILE_SIZE` = `25 * 1024 * 1024` | Rejeita payloads maiores com `413`. Define `Number.POSITIVE_INFINITY` para abdicares do limite deliberadamente |
| `allowedTypes` | `string[]` | qualquer tipo | Allowlist com wildcards `type/*` (`'image/*'`). Comparada com o `contentType` **que passas ao `upload`** |

### `fileRoutes()`

Não aceita opções. Todas as rotas declaram `meta: { auth: true }` — não há
escape `auth: false`, ao contrário de `billingRoutes`. Se a autenticação
acontecer mesmo numa borda exterior, dispensa a verificação de arranque com o
`allowUnguardedMeta` do adaptador em vez de remover o meta.

`POST /files/:id/url` aceita `{ expiresIn }` como string de duração (`'30s'`,
`'15m'`, `'2h'`, `'7d'`) ou em milissegundos; a predefinição é `'15m'` e assina
sempre com a disposição `attachment`.

### Métodos do serviço `Files`

| Método | Porquê |
| --- | --- |
| `upload(content, input)` | O pipeline. `input` é `{ name, contentType, tenantId?, uploadedBy?, metadata? }` |
| `get(id, tenantId?)` | `FileRecord \| null` — não lança se não encontrar |
| `list(tenantId?)` | Todos os registos do tenant |
| `download(id, tenantId?)` | `{ record, content }`; lança `FileNotFoundError` |
| `temporaryUrl(id, expiresIn, tenantId?, { disposition? })` | URL assinado; `attachment` por predefinição |
| `delete(id, tenantId?)` | Remove objeto + registo, emite `file:deleted`; idempotente |
| `markScanned(id, { clean, detail? }, tenantId?)` | Regista o resultado de uma análise fora de banda, emite `file:scanned` |

## Modos de falha e resolução de problemas

| Erro | Código | HTTP | Quando |
| --- | --- | --- | --- |
| `FileTooLargeError` | `FILE_TOO_LARGE` | 413 | Payload acima de `validate.maxSize` — 25 MiB por predefinição, mesmo sem `validate` |
| `FileTypeNotAllowedError` | `FILE_TYPE_NOT_ALLOWED` | 415 | `contentType` não correspondido por `validate.allowedTypes` |
| `StorageQuotaExceededError` | `FILE_QUOTA_EXCEEDED` | 402 | `maxTotalBytes` seria excedido por este upload |
| `FileNotFoundError` | `FILE_NOT_FOUND` | 404 | `download` / `markScanned` / `GET /files/:id` para um id que não é deste tenant |
| `FileTenantRequiredError` | `FILE_TENANT_REQUIRED` | 400 | Sem argumento `tenantId` **e** sem `ctx().tenant` — tipicamente um worker de fila ou a CLI |
| `UnknownDiskError` | `STORAGE_UNKNOWN_DISK` | — | `disk: 'name'` não corresponde a nenhum disco em `storagePlugin({ disks })` |
| `TemporaryUrlUnsupportedError` | `STORAGE_TEMPORARY_URL_UNSUPPORTED` | — | `temporaryUrl` no driver `local` |
| `StorageFileNotFoundError` | `STORAGE_FILE_NOT_FOUND` | — | O registo existe mas o objeto não — bytes apagados fora de banda, ou o disco/`scope` mudou por baixo dos registos |
| `ImageProcessingUnavailableError` | `STORAGE_IMAGE_UNAVAILABLE` | — | `disk.image(…)` sem `imageProcessor` no `storagePlugin` |
| `UnguardedRouteMetaError` | `HTTP_UNGUARDED_ROUTE_META` | arranque | `fileRoutes()` registado sem `authPlugin` — todas as rotas declaram `meta.auth` |

- **`400 FILE_TENANT_REQUIRED` a partir de um worker de fila ou de um cron** —
  não há tenant ambiente fora de um pedido. Põe o `tenantId` no payload do job e
  passa-o a todas as chamadas de `Files`.
- **`GET /files` devolve os ficheiros de outro tenant** — o identificador do
  tenant é fornecido pelo cliente e `meta.auth` não verifica pertença. Regista o
  [`tenantMembershipPlugin()`](/pt/guide/teams).
- **Os ficheiros desaparecem depois de um redeploy, mas os bytes continuam no
  bucket** — continuas no `MemoryFileStore`. Implementa `FileStore` sobre a tua
  base de dados.
- **`STORAGE_TEMPORARY_URL_UNSUPPORTED` só em desenvolvimento** — o driver
  `local` não consegue assinar URLs. Serve por `files.download()` em dev, ou corre
  o MinIO atrás de um disco `s3` para os dois ambientes se comportarem igual.
- **Um URL assinado descarrega em vez de pré-visualizar** — essa é a
  predefinição fail-closed. Passa `{ disposition: 'inline' }` por URL quando a
  renderização de topo for deliberada.
- **A quota do plano nunca recupera depois dos deletes** — um `checkQuota`
  construído sobre `features().consume()` só incrementa. Liberta as unidades em
  `file:deleted`.

## Eventos

| Hook | Payload |
| --- | --- |
| `file:uploaded` | `{ file }` — despacha aqui o job de análise/miniatura |
| `file:deleted` | `{ tenantId, id }` |
| `file:scanned` | `{ file }` — emitido por `markScanned` |

## Ver também

- [Armazenamento](/pt/guide/storage) — discos, drivers, URLs assinados, pipeline
  de imagem.
- [Equipas](/pt/guide/teams) — `tenantMembershipPlugin()`, a guarda que torna as
  rotas acima realmente seguras por tenant.
- [Filas e jobs](/pt/guide/queues) — correr análises e transcodificações fora do
  pedido.
- [Cookbook de SaaS multi-tenant](/pt/cookbook/multi-tenant-saas) — a stack
  inteira numa app.
