# Storage

`@basaltkit/storage` dá a cada backend uma só API — um **Disk** com
`put`/`get`/`exists`/`delete`/`list` e `temporaryUrl`s assinados — e faz o scope de
cada path por tenant automaticamente. O driver do sistema de ficheiros vem no
núcleo; todos os backends de cloud — S3, Google Cloud Storage, Azure Blob — são
pacotes de driver drop-in, por isso instalas apenas o SDK que usas mesmo.

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

Os uploads são ilimitados por omissão **nesta camada** (o pipeline de nível
superior [`@basaltkit/files`](/pt/guide/files) limita os uploads a 25 MiB mesmo
quando não configuras nada); passa limites opt-in ao `put` para limitar o
tamanho e restringir o content-type (aplicados na fachada, antes de qualquer
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
    invoices: s3Disk({ bucket: 'company-invoices', region: 'eu-west-1' }),
  },
})

const storage = app.container.get(STORAGE)
await storage.disk().put('avatar.png', image)              // disco predefinido
await storage.disk('invoices').put('2026/01.pdf', invoice) // pelo nome
```

`storage.disk('unknown')` lança `UnknownDiskError`.

## Drivers

O backend é escolhido por disco. O `local` é a única string — não precisa de
biblioteca cliente nenhuma, só de `fs`. Todos os drivers de cloud chegam como
instância, do seu próprio pacote, com o SDK como peer dependency que instalas:

```ts
import { s3Disk } from '@basaltkit/storage-s3'
import { GcsStorageDriver } from '@basaltkit/storage-gcs'
import { AzureBlobStorageDriver } from '@basaltkit/storage-azure'

storagePlugin({
  disks: {
    uploads: { driver: 'local', root: './storage' },
    s3:      s3Disk({ bucket: 'my-bucket', region: 'eu-west-1' }),
    gcs:   { driver: new GcsStorageDriver({ bucket: 'my-bucket', projectId: 'my-project' }) },
    azure: { driver: new AzureBlobStorageDriver({ container: 'uploads', connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING }) },
  },
})
```

| Driver | Pacote | Notas |
| --- | --- | --- |
| Local | `@basaltkit/storage` | Sistema de ficheiros — dev e nó único. Sem `temporaryUrl` |
| S3 | `@basaltkit/storage-s3` | AWS S3, MinIO, Cloudflare R2 (peers: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`) |
| GCS | `@basaltkit/storage-gcs` | Google Cloud Storage (peer: `@google-cloud/storage`) |
| Azure Blob | `@basaltkit/storage-azure` | Azure Blob (URLs assinados SAS; peer: `@azure/storage-blob`) |

### S3, MinIO e Cloudflare R2

```bash
pnpm add @basaltkit/storage-s3 @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

O `s3Disk()` comunica com qualquer serviço compatível com S3. Para a AWS, `bucket`
(e normalmente `region`) chega — as credenciais vêm da cadeia AWS padrão. Para MinIO
ou R2, define um `endpoint`:

```ts
import { s3Disk } from '@basaltkit/storage-s3'
```

```ts
storagePlugin({
  disks: {
    uploads: s3Disk({
      bucket: 'my-app',
      region: 'eu-west-1',
      endpoint: 'http://localhost:9000',          // MinIO / R2 — forcePathStyle passa a true automaticamente
      credentials: { accessKeyId: '…', secretAccessKey: '…' }, // omite para usar o ambiente AWS
    }),
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

## Pipeline de imagem

Todos os discos expõem um pipeline fluente de imagem quando o `storagePlugin`
recebe um `imageProcessor` (do `@basaltkit/image-sharp` — mantido fora do core
para que apps que nunca processam imagens não carreguem uma dependência nativa):

```ts
import { SharpImageProcessor } from '@basaltkit/image-sharp'

storagePlugin({ disks: { /* … */ }, imageProcessor: new SharpImageProcessor() })

await disk.image('avatar.png').resize(256, 256).webp().save('avatar.webp')
```

Sem processador, o terminal do pipeline lança
`ImageProcessingUnavailableError`.

## Referência de opções

### `storagePlugin(options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `disks` | `Record<string, DiskConfig>` | — (obrigatório) | Os discos nomeados; cada um escolhe um driver |
| `default` | `string` | primeiro disco declarado | O disco devolvido por `storage.disk()` sem argumento |
| `imageProcessor` | `ImageProcessor` | nenhum | O motor por trás de `disk.image(…)` — passa o `SharpImageProcessor` do `@basaltkit/image-sharp` |

### `DiskConfig` (por disco)

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `driver` | `'local' \| 's3' \| StorageDriver` | — (obrigatório) | `'local'` precisa de `root`; `'s3'` recebe as opções S3; uma instância liga GCS/Azure/custom |
| `scope` | `(() => string \| undefined) \| null` | `tenants/<ctx().tenant.id>` | Prefixo de path dinâmico resolvido em **todas** as operações — isolamento automático por tenant. `null` desativa-o |

### `PutOptions` (por `put`)

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `contentType` | `string` | nenhum | Content type armazenado/servido (o S3 define `Content-Type`) |
| `maxBytes` | `number` | sem limite | Limite de tamanho imposto na fachada — rejeita com `STORAGE_TOO_LARGE` antes de qualquer driver correr |
| `allowedContentTypes` | `readonly string[]` | qualquer | Allowlist imposta na fachada — um `contentType` em falta ou fora da lista rejeita com `STORAGE_CONTENT_TYPE` |

### `TemporaryUrlOptions` (por `temporaryUrl`)

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `disposition` | `'attachment' \| 'inline'` | `'attachment'` | Fecha por omissão o vetor de um HTML/SVG carregado renderizar top-level na origem storage/CDN (stored XSS). Opta por `'inline'` só quando a renderização top-level é deliberada |

A predefinição de disposition é honrada pelos três drivers de assinatura — S3
(`ResponseContentDisposition`), GCS (`responseDisposition`) e Azure (SAS
`contentDisposition`).

## Modos de falha e resolução de problemas

| Classe | Código | Quando |
| --- | --- | --- |
| `StorageFileNotFoundError` | `STORAGE_FILE_NOT_FOUND` | `get` num ficheiro que não existe |
| `StorageInvalidKeyError` | `STORAGE_INVALID_KEY` | A key começa por `/`/`\\`, contém um segmento `..` ou caracteres de controlo — o ponto único da fachada rejeita-a em **todas** as operações, para todos os drivers, antes de o prefixo de tenant ser aplicado |
| `StorageInvalidPathError` | `STORAGE_INVALID_PATH` | Um path escapa à root do disco — a segunda linha de defesa própria do driver local |
| `StorageTooLargeError` | `STORAGE_TOO_LARGE` | `put` com `maxBytes` definido e um payload maior |
| `StorageContentTypeError` | `STORAGE_CONTENT_TYPE` | `put` com `allowedContentTypes` definido e um content type em falta/fora da lista |
| `UnknownDiskError` | `STORAGE_UNKNOWN_DISK` | `disk('name')` para um disco que não foi declarado |
| `TemporaryUrlUnsupportedError` | `STORAGE_TEMPORARY_URL_UNSUPPORTED` | `temporaryUrl` num driver sem suporte (ex.: `local`) |
| `ImageProcessingUnavailableError` | `STORAGE_IMAGE_UNAVAILABLE` | Terminal de `disk.image(…)` sem `imageProcessor` configurado |

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
