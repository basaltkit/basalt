# Storage

`@basaltkit/storage` dá a cada backend uma só API — um **Disk** com
`put`/`get`/`exists`/`delete`/`list` e `temporaryUrl`s assinados — e faz o scope de
cada path por tenant automaticamente. O disco local e o S3 vêm no núcleo; o Google
Cloud Storage e o Azure Blob são pacotes de driver drop-in.

[[toc]]

## Setup

`storagePlugin` regista um `Storage` sob o token `STORAGE`. Declara um ou mais discos
nomeados; começa com o driver `local`, que só precisa de uma pasta:

```ts
import { createApp } from '@basaltkit/core'
import { storagePlugin, STORAGE } from '@basaltkit/storage'

const app = await createApp({
  plugins: [
    storagePlugin({
      default: 'uploads',
      disks: {
        uploads: { driver: 'local', root: './storage' },
      },
    }),
  ],
}).boot()

const disk = app.container.get(STORAGE).disk()   // o disco predefinido ('uploads')
await disk.put('avatars/1.png', buffer, { contentType: 'image/png' })
```

Cada `Disk` prefixa paths com `tenants/<id>` de `ctx().tenant` — por isso o mesmo
código mantém os ficheiros de cada tenant isolados. Passa `scope: null` num disco
para desligar isso.

## put / get / exists / delete / list

`put` aceita uma string ou `Buffer` e cria pastas intermédias; `get` retorna sempre
os bytes brutos como um `Buffer`:

```ts
await disk.put('docs/read-me.txt', 'hello')
await disk.put('img/pixel.bin', Buffer.from([1, 2, 3]))
await disk.put('report.pdf', pdfBuffer, { contentType: 'application/pdf' }) // o S3 define o Content-Type

const text = (await disk.get('docs/read-me.txt')).toString()  // Buffer → string

await disk.exists('docs/read-me.txt')  // true
await disk.delete('docs/read-me.txt')  // true (existia e foi apagado)
await disk.delete('docs/read-me.txt')  // false (já não existia)

await disk.list('docs')  // ['docs/read-me.txt', ...] — recursivo, ordenado
await disk.list()        // todos os ficheiros no scope atual
```

`get` num ficheiro inexistente lança `StorageFileNotFoundError`.

## Validar keys e uploads

As object keys são validadas em todas as operações e em **todos** os drivers:
uma key com barra inicial, um segmento `..` ou caracteres de controlo é rejeitada
com `StorageInvalidKeyError` — por isso uma key fornecida pelo utilizador nunca
pode escapar ao seu prefixo nem colidir com a de outro tenant.

Os uploads são ilimitados por omissão; passa limites opt-in ao `put` para limitar
o tamanho e restringir o content-type (aplicados na fachada, antes de qualquer
driver correr):

```ts
await disk.put(key, buffer, {
  contentType: 'image/png',
  maxBytes: 5 * 1024 * 1024,                          // → StorageTooLargeError acima de 5 MiB
  allowedContentTypes: ['image/png', 'image/jpeg'],   // → StorageContentTypeError caso contrário
})
```

## Múltiplos discos nomeados

Declara tantos discos quantos quiseres — ex.: uploads públicos num backend, faturas
noutro — e escolhe um pelo nome:

```ts
storagePlugin({
  default: 'uploads',
  disks: {
    uploads:  { driver: 'local', root: './storage/uploads' },
    invoices: { driver: 's3', bucket: 'company-invoices', region: 'eu-west-1' },
  },
})

const storage = app.container.get(STORAGE)
await storage.disk().put('avatar.png', image)              // disco predefinido
await storage.disk('invoices').put('2026/01.pdf', invoice) // pelo nome
```

`storage.disk('unknown')` lança `UnknownDiskError`.

## Drivers

O backend é escolhido por disco. `local` e `s3` são strings; os drivers de cloud são
instâncias (traz o SDK como peer dependency):

```ts
import { GcsStorageDriver } from '@basaltkit/storage-gcs'
import { AzureBlobStorageDriver } from '@basaltkit/storage-azure'

storagePlugin({
  disks: {
    gcs:   { driver: new GcsStorageDriver({ bucket: 'my-bucket', projectId: 'my-project' }) },
    azure: { driver: new AzureBlobStorageDriver({ container: 'uploads', connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING }) },
  },
})
```

| Driver | Pacote | Notas |
| --- | --- | --- |
| Local | `@basaltkit/storage` | Sistema de ficheiros — dev e nó único. Sem `temporaryUrl` |
| S3 | `@basaltkit/storage` | AWS S3, MinIO, Cloudflare R2 (compatível com S3) |
| GCS | `@basaltkit/storage-gcs` | Google Cloud Storage (peer: `@google-cloud/storage`) |
| Azure Blob | `@basaltkit/storage-azure` | Azure Blob (URLs assinados SAS; peer: `@azure/storage-blob`) |

### S3, MinIO e Cloudflare R2

O driver `s3` comunica com qualquer serviço compatível com S3. Para a AWS, `bucket`
(e normalmente `region`) chega — as credenciais vêm da cadeia AWS padrão. Para MinIO
ou R2, define um `endpoint`:

```ts
storagePlugin({
  disks: {
    uploads: {
      driver: 's3',
      bucket: 'my-app',
      region: 'eu-west-1',
      endpoint: 'http://localhost:9000',          // MinIO / R2 — forcePathStyle passa a true automaticamente
      credentials: { accessKeyId: '…', secretAccessKey: '…' }, // omite para usar o ambiente AWS
    },
  },
})
```

## URLs assinados

Entrega a um cliente um URL de tempo limitado diretamente para o objeto, sem proxy:

```ts
const url = await disk.temporaryUrl('reports/q1.pdf', '15m')
// renderizar top-level (p.ex. pré-visualizar um PDF) é opt-in deliberado:
const preview = await disk.temporaryUrl('reports/q1.pdf', '15m', { disposition: 'inline' })
```

URLs assinados servem `Content-Disposition: attachment` **por defeito** — um
ficheiro HTML ou SVG carregado é descarregado em vez de renderizar na origem
do storage/CDN (um vetor de stored-XSS quando essa origem partilha cookies com
a tua app). Usos embebidos (`<img>`, `<video>`) renderizam independentemente
da disposition, por isso avatares e previews dentro de páginas continuam a
funcionar.

A expiração aceita uma string de duração (`'500ms'`, `'30s'`, `'15m'`, `'2h'`,
`'7d'`) ou milissegundos. Suportado por `s3`, GCS e Azure; o driver `local` lança
`TemporaryUrlUnsupportedError` (serve ficheiros locais através de uma rota em dev, ou
corre MinIO localmente com um disco `s3`).

`@basaltkit/files` constrói um pipeline de upload por cima disto (validação, quota,
metadados) — vê o [guia de File uploads](/pt/guide/files).

## Erros

| Classe | Código | Quando |
| --- | --- | --- |
| `StorageFileNotFoundError` | `STORAGE_FILE_NOT_FOUND` | `get` num ficheiro que não existe |
| `StorageInvalidPathError` | `STORAGE_INVALID_PATH` | Um path escapa à root do disco (`../…`) — o driver local bloqueia traversal |
| `UnknownDiskError` | `STORAGE_UNKNOWN_DISK` | `disk('name')` para um disco que não foi declarado |
| `TemporaryUrlUnsupportedError` | `STORAGE_TEMPORARY_URL_UNSUPPORTED` | `temporaryUrl` num driver sem suporte (ex.: `local`) |

Todos estendem `BasaltError` e transportam o `code` acima.

## Escrever um driver

Um driver implementa o contrato `StorageDriver` — seis métodos:

```ts
import { StorageFileNotFoundError, type PutOptions, type StorageDriver } from '@basaltkit/storage'

export class MyStorageDriver implements StorageDriver {
  readonly name = 'my-backend'
  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<void> { /* … */ }
  async get(path: string): Promise<Buffer> { /* lança StorageFileNotFoundError em miss */ throw 0 }
  async exists(path: string): Promise<boolean> { /* … */ return false }
  async delete(path: string): Promise<boolean> { /* retorna se existia */ return false }
  async list(prefix: string): Promise<string[]> { /* chaves sob o prefixo */ return [] }
  async temporaryUrl(path: string, expiresInMs: number): Promise<string> { /* opcional */ throw 0 }
  async disconnect(): Promise<void> {}
}
```

Depois liga-o como instância: `disks: { d: { driver: new MyStorageDriver() } }`.
Os drivers de cloud incluídos ([`@basaltkit/storage-gcs`][gcs], [`-azure`][az])
recebem um **cliente injetável**, pelo que a sua lógica é testada unitariamente com um
fake — sem conta de cloud. Faz o mesmo e o teu driver fica testável em CI.

[gcs]: https://github.com/basaltkit/basalt/tree/main/packages/storage-gcs
[az]: https://github.com/basaltkit/basalt/tree/main/packages/storage-azure
