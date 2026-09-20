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

**Falha fechado sem tenant.** Com `@basaltkit/tenancy` registado, um disco com o
scope predefinido recusa correr sem tenant no contexto e lança
`StorageTenantRequiredError` (`400 STORAGE_TENANT_REQUIRED`). Sem isso, um pedido
que simplesmente omitisse o tenant resolveria a chave do chamador contra a raiz do
bucket, onde `tenants/<outro-tenant>/…` está acessível pelo nome. Um disco
deliberadamente central (backups, branding da plataforma) declara-o
explicitamente: `scope: null`, ou `onMissingScope: 'root'` para um disco que tem
scope de tenant dentro de um tenant e é central fora dele. Apps sem tenancy não
são afetadas.

Um id de tenant que não seja um único segmento de path seguro (`..`, `a/b`,
caracteres de controlo) é recusado com `StorageInvalidScopeError` em vez de ser
juntado ao path.

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

## Ficheiros grandes

`put`/`get` movem o objeto inteiro pela memória, o que é a forma errada para um
vídeo de 2 GB, uma importação CSV ou um dump de base de dados. Quatro
**capacidades opcionais do driver** cobrem esse caso. `local`, `s3`, `azure` e
`gcs` implementam as quatro; um driver que não as tenha lança um erro claro
`STORAGE_*_UNSUPPORTED`, e `disk.supports(capacidade)` responde antes de
chamares.

```ts
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

// Upload sem nunca segurar o corpo. Fonte: Readable do Node, ReadableStream
// web, ou qualquer AsyncIterable<Uint8Array>.
await disk.putStream('imports/2026.csv', request.raw, {
  contentType: 'text/csv',
  contentLength: declaredSize,        // quando o cliente enviou um Content-Length
  maxBytes: 200 * 1024 * 1024,        // aplicado ENQUANTO transmite
})

// Download como stream — consome-a ou faz destroy(), nunca a abandones.
await pipeline(await disk.getStream('imports/2026.csv'), createWriteStream('/tmp/2026.csv'))

// Cópia sem os bytes saírem do backend.
await disk.copy('drafts/a.pdf', 'final/a.pdf')
await disk.copy('drafts/a.pdf', 'a.pdf', { disk: storage.disk('cold') })

// Metadados sem download.
const { size, contentType, etag, lastModified } = await disk.stat('final/a.pdf')
```

As mesmas regras de segurança do `put`: a key é validada e prefixada com o
tenant (falhando fechado sem tenant), `allowedContentTypes` é verificado antes
de um único byte ser lido, e passado o `maxBytes` o upload é abortado com
`StorageTooLargeError` enquanto a fonte é destruída (`Readable` do Node) ou
cancelada (`ReadableStream` web) — nada para além do limite chega a ser lido.

| Capacidade | S3 | Azure | GCS | Local |
| --- | --- | --- | --- | --- |
| `putStream` | `PutObject` com `contentLength` ou `maxBytes`; multipart sem nenhum dos dois | `uploadStream` (qualquer tamanho) | `createWriteStream` (qualquer tamanho) | stream de escrita `fs` |
| `getStream` | corpo do `GetObject` | `download()` | `createReadStream` | stream de leitura `fs` |
| `copy` | `CopyObject` | `syncCopyFromURL` (≤ 256 MiB) | `file.copy()` | `fs.copyFile` |
| `stat` | `HeadObject` | `getProperties()` | `getMetadata()` | `fs.stat` (só tamanho + mtime) |

::: warning O S3 e o tamanho do corpo
O `PutObject` não consegue enviar um corpo de tamanho desconhecido. O
`putStream` transmite diretamente quando passas `contentLength`; só com
`maxBytes` acumula até esse limite (memória limitada, escolha deliberada). Sem
**nenhum dos dois**, o driver envia o corpo em **multipart** — qualquer tamanho,
com apenas `partSizeBytes × queueSize` em memória — desde que o peer opcional
`@aws-sdk/lib-storage` esteja instalado:

```bash
pnpm add @aws-sdk/lib-storage
```

É carregado de forma preguiçosa, só nesse caminho, por isso uma app que não o
instale fica exatamente como estava — e aí o `putStream` sem nenhuma das duas
opções continua a lançar `StorageStreamLengthRequiredError`
(`400 STORAGE_STREAM_LENGTH_REQUIRED`), nomeando o pacote que o permitiria.
Afina o envio com as opções de disco `partSizeBytes` (por omissão 5 MiB, o
mínimo do S3) e `queueSize` (por omissão 4). Uma parte que falhe — incluindo o
limite `maxBytes` — aborta o upload e destrói a fonte, para não ficarem partes
órfãs; acrescenta ao bucket uma regra de ciclo de vida
`AbortIncompleteMultipartUpload` como rede de segurança, já que partes
incompletas não aparecem nas listagens e são faturadas até serem removidas.
Azure e GCS fragmentam streams de tamanho desconhecido nativamente.
:::

O `copy` recorre a alternativas quando uma cópia server-side é impossível — um
driver diferente, ou um sem `copy`: primeiro `getStream` → `putStream`, depois
`get` → `put`. Ambas movem os bytes por este processo, por isso passa
`{ requireServerSide: true }` onde um download-e-reupload silencioso de um
objeto enorme seria um bug (`CopyUnsupportedError`). Um upload em stream que
falhe pode deixar um objeto parcial em backends que não conseguem reverter;
apaga a key quando isso importar (o `@basaltkit/files` já o faz).

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

Todas as opções de disco (`scope`, `onMissingScope`, `maxTemporaryUrlTtl`,
`maxTemporaryUploadUrlTtl`) podem ser passadas a `s3Disk()` junto das opções do
driver — ele separa-as e encaminha cada uma para o sítio certo.

**Encriptação em repouso.** A configuração mais simples é a encriptação por
omissão do próprio bucket (a AWS já encripta novos objetos com SSE-S3 por
omissão; define uma chave KMS por omissão no bucket se precisares de uma) —
nada a configurar aqui. Quando a app tem de a fixar, define
`serverSideEncryption` e o driver envia-a em cada `put` e assina-a em cada
[upload pré-assinado](#uploads-diretos-do-browser):

```ts
s3Disk({ bucket: 'docs', serverSideEncryption: 'AES256' })                        // SSE-S3
s3Disk({ bucket: 'docs', serverSideEncryption: { kms: 'alias/docs-key' } })        // SSE-KMS
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
`'7d'`) ou milissegundos. Está **limitada a 7 dias** por omissão (o limite das
assinaturas S3 e GCS, agora aplicado a todos os drivers, Azure incluído): um URL
assinado é uma credencial ao portador que sobrevive à saída do titular do tenant,
por isso uma duração maior (ou não positiva) lança `TemporaryUrlTtlTooLongError`
(`400 STORAGE_TEMPORARY_URL_TTL`). Baixa o limite por disco com
`maxTemporaryUrlTtl`. Suportado por `s3`, GCS e Azure; o driver `local` lança
`TemporaryUrlUnsupportedError` (serve ficheiros locais através de uma rota em dev, ou
corre MinIO localmente com um disco `s3`).

## Uploads diretos do browser

Para ficheiros grandes, deixa o browser fazer `PUT` diretamente para o bucket em
vez de passar pelo teu servidor. O servidor emite um **URL de upload
pré-assinado** de curta duração, ligado ao content type exato (e ao tamanho /
checksum quando indicados):

```ts
import { randomUUID } from 'node:crypto'

const ALLOWED = { 'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf' } as const

// POST /uploads — o cliente diz o que quer carregar; o servidor decide onde.
const { contentType, size } = req.body            // valida primeiro com o teu schema
const upload = await disk.temporaryUploadUrl(`uploads/${randomUUID()}.${ALLOWED[contentType]}`, {
  expiresIn: '5m',
  contentType,                                    // obrigatório, sempre assinado
  contentLength: size,                            // assinado: qualquer outro tamanho é rejeitado
  maxBytes: 20 * 1024 * 1024,                     // → StorageTooLargeError acima de 20 MiB
  allowedContentTypes: Object.keys(ALLOWED),      // → StorageContentTypeError caso contrário
})
return { url: upload.url, method: upload.method, headers: upload.headers, key: upload.key }
```

```ts
// Browser
const res = await fetch(url, { method, headers, body: file })   // envia `headers` tal como vêm
if (!res.ok) throw new Error('upload failed')
await fetch('/uploads/complete', { method: 'POST', body: JSON.stringify({ key }) })
```

`temporaryUploadUrl` segue as mesmas regras de segurança que `temporaryUrl`: a
key é validada, prefixada com o tenant (e falha fechado sem tenant), e a duração
é limitada — por `maxTemporaryUploadUrlTtl`, que por omissão é **1 hora** (ou
`maxTemporaryUrlTtl` quando for menor). Devolve
`{ url, method: 'PUT', headers, expiresAt, key }`; `key` é a key completa do
objeto, prefixo do tenant incluído.

| Driver | Liga `contentType` | Liga `contentLength` | `checksumSha256` |
| --- | --- | --- | --- |
| S3 | header assinado | header assinado | assinado; o S3 verifica o corpo |
| GCS | assinado (V4) | `x-goog-content-length-range` assinado | recusado (`STORAGE_UPLOAD_URL_UNSUPPORTED`) |
| Azure | **não aplicável** (enviado como header) | **não aplicável** | recusado (`STORAGE_UPLOAD_URL_UNSUPPORTED`) |
| Local | não suportado — `TemporaryUploadUrlUnsupportedError` (`STORAGE_UPLOAD_URL_UNSUPPORTED`) | — | — |

No S3 os headers SSE de `serverSideEncryption` também são assinados, por isso o
cliente não pode saltar a encriptação. O Azure usa um SAS só de create/write,
que não consegue ligar headers do pedido.

::: warning Checklist de segurança
- **Gera a key no servidor** (p.ex. um UUID) — nunca aceites um caminho vindo do cliente.
- **Liga sempre `contentType`** (obrigatório) e **`contentLength`** — sem tamanho
  o cliente pode carregar qualquer tamanho. Mantém uma allowlist de tipos.
- **Mantém o TTL curto** — minutos. O URL é uma credencial de escrita para essa
  key até expirar; quem o tiver pode carregar.
- **Prefixa a key com o tenant** — o scope por omissão do disco faz isto; não o desligues para uploads de utilizadores.
- **Trata o objeto carregado como não confiável** até um passo de "complete" o
  verificar (existe, tem o tamanho/tipo esperado — obrigatório no Azure, onde
  nada fica ligado). Serve-o com `temporaryUrl` (attachment por omissão), nunca inline.
- **Configura o CORS do bucket** para permitir `PUT` a partir da origem da tua
  app com os headers devolvidos, e nada mais largo.
:::

### Assinar para outro endpoint

Às vezes o processo que vai *usar* o URL chega ao bucket por um host diferente
do da API: um worker de ingestão isolado em `http://minio:9000` dentro da rede
de contentores, um alias público de CDN à frente do S3. Assina para esse host
com um `endpoint` por chamada, ou um valor por omissão no disco:

```ts
await disk.temporaryUploadUrl(key, { expiresIn: '5m', contentType, endpoint: 'http://minio:9000' })
await disk.temporaryUrl(key, '15m', { endpoint: 'https://files.example.com' })

// por omissão para todos os URLs que este disco assina (um endpoint por chamada ganha)
s3Disk({ bucket: 'uploads', endpoint: 'http://minio:9000', signingEndpoint: 'https://files.example.com' })
```

Só o host assinado muda — região, path style, credenciais e SSE ficam como
configurados, e os headers ligados `Content-Type` / `Content-Length` / checksum
não mudam. **Só S3:** o Azure deriva o SAS do host da conta do blob client e o
GCS liga as assinaturas V4 ao host do bucket, por isso ambos recusam a
substituição com `STORAGE_TEMPORARY_URL_UNSUPPORTED` /
`STORAGE_UPLOAD_URL_UNSUPPORTED` em vez de emitir um URL para o host errado.

::: warning Um valor de deployment, nunca input do cliente
O endpoint tem de ser outro nome para o **mesmo** bucket. Uma assinatura emitida
para um host que não controlas é uma credencial entregue a esse host, por isso
nunca o construas a partir de um pedido. É validado (`http(s)` absoluto, sem
credenciais, sem query nem fragmento) — qualquer outra coisa lança
`StorageSigningEndpointInvalidError` (`400 STORAGE_SIGNING_ENDPOINT_INVALID`).
:::

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
| `onMissingScope` | `'root' \| 'error'` | `'error'` com tenancy registado e o `scope` predefinido; `'root'` caso contrário | O que uma operação faz sem tenant no contexto: `'error'` lança `StorageTenantRequiredError`, `'root'` usa a chave contra a raiz do disco. Um valor explícito ganha sempre |
| `maxTemporaryUrlTtl` | `DurationInput` | `'7d'` | Duração máxima que `temporaryUrl` aceita; acima disso lança `TemporaryUrlTtlTooLongError` |
| `maxTemporaryUploadUrlTtl` | `DurationInput` | `'1h'` (ou `maxTemporaryUrlTtl` se for menor) | Duração máxima que `temporaryUploadUrl` aceita; acima disso lança `TemporaryUrlTtlTooLongError` |

### `PutOptions` (por `put`)

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `contentType` | `string` | nenhum | Content type armazenado/servido (o S3 define `Content-Type`) |
| `maxBytes` | `number` | sem limite | Limite de tamanho imposto na fachada — rejeita com `STORAGE_TOO_LARGE` antes de qualquer driver correr |
| `allowedContentTypes` | `readonly string[]` | qualquer | Allowlist imposta na fachada — um `contentType` em falta ou fora da lista rejeita com `STORAGE_CONTENT_TYPE` |

### `PutStreamInput` (por `putStream`)

Tudo o que vem de `PutOptions` (`maxBytes`, `allowedContentTypes`) mais:

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `contentType` | `string` | — (obrigatório) | Uma stream não tem bytes a que recorrer, por isso o tipo é declarado à partida e verificado contra `allowedContentTypes` antes de qualquer byte ser lido |
| `contentLength` | `number` | nenhum | Tamanho exato do corpo quando conhecido. **Obrigatório no S3** salvo se `maxBytes` estiver definido |

### `CopyOptions` (por `copy`)

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `disk` | `Disk` | o disco de origem | Disco de destino; a key é prefixada pelo scope **desse** disco |
| `contentType` | `string` | o da origem | Content type do objeto de destino |
| `maxBytes` | `number` | sem limite | Limite para uma cópia por fallback — a única cujos bytes passam por este processo |
| `requireServerSide` | `boolean` | `false` | Lança `CopyUnsupportedError` em vez de recorrer a um download-e-reupload |

### `StorageStat` (devolvido por `stat`)

| Campo | Tipo | Notas |
| --- | --- | --- |
| `size` | `number` | Bytes |
| `contentType` | `string \| undefined` | Não reportado pelo `local` |
| `etag` | `string \| undefined` | Tal como o backend o devolve; não reportado pelo `local` |
| `lastModified` | `Date \| undefined` | `mtime` no `local` |

### `TemporaryUrlOptions` (por `temporaryUrl`)

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `disposition` | `'attachment' \| 'inline'` | `'attachment'` | Fecha por omissão o vetor de um HTML/SVG carregado renderizar top-level na origem storage/CDN (stored XSS). Opta por `'inline'` só quando a renderização top-level é deliberada |
| `endpoint` | `string` | o do próprio driver | Assina para outro host do **mesmo** bucket (só S3; Azure/GCS recusam). Vê [Assinar para outro endpoint](#assinar-para-outro-endpoint) |

### `TemporaryUploadUrlOptions` (por `temporaryUploadUrl`)

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `expiresIn` | `DurationInput` | — (obrigatório) | Duração do URL, limitada por `maxTemporaryUploadUrlTtl` |
| `contentType` | `string` | — (obrigatório) | O único content type que o upload pode declarar — assinado no URL (S3, GCS) |
| `contentLength` | `number` | nenhum | Tamanho exato do corpo em bytes — assinado (S3, GCS). Sem ele qualquer tamanho é aceite |
| `checksumSha256` | `string` (base64) | nenhum | SHA-256 do corpo — assinado e verificado pelo S3; recusado por GCS e Azure |
| `maxBytes` | `number` | sem limite | Limite imposto na fachada sobre o `contentLength` declarado (que passa a obrigatório) |
| `allowedContentTypes` | `readonly string[]` | qualquer | Allowlist imposta na fachada para `contentType` |
| `endpoint` | `string` | o do próprio driver | Assina para outro host do **mesmo** bucket — um valor de deployment, nunca input do cliente (só S3) |

### Opções de `s3Disk` / `S3StorageDriver`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `bucket` | `string` | — (obrigatório) | Bucket de destino |
| `region` | `string` | `'us-east-1'` | Região AWS |
| `endpoint` | `string` | AWS | MinIO / R2 / qualquer endpoint compatível com S3 |
| `credentials` | `{ accessKeyId, secretAccessKey }` | cadeia de credenciais AWS | Credenciais estáticas |
| `forcePathStyle` | `boolean` | `true` quando `endpoint` está definido | URLs path-style (MinIO) |
| `serverSideEncryption` | `'AES256' \| { kms: string }` | nenhuma (aplica-se a do bucket) | SSE enviada em cada `put` e assinada em cada upload pré-assinado |
| `signingEndpoint` | `string` | `endpoint` | Host por omissão para o qual os URLs pré-assinados são assinados, quando difere daquele com que este processo fala. Um `endpoint` por chamada ganha |

A predefinição de disposition é honrada pelos três drivers de assinatura — S3
(`ResponseContentDisposition`), GCS (`responseDisposition`) e Azure (SAS
`contentDisposition`).

## Modos de falha e resolução de problemas

| Classe | Código | Quando |
| --- | --- | --- |
| `StorageFileNotFoundError` | `STORAGE_FILE_NOT_FOUND` | `get` num ficheiro que não existe |
| `StorageInvalidKeyError` | `STORAGE_INVALID_KEY` | A key começa por `/`/`\\`, contém um segmento `..` ou caracteres de controlo — o ponto único da fachada rejeita-a em **todas** as operações, para todos os drivers, antes de o prefixo de tenant ser aplicado |
| `StorageInvalidPathError` | `STORAGE_INVALID_PATH` | Um path escapa à root do disco — a segunda linha de defesa própria do driver local |
| `StorageTooLargeError` | `STORAGE_TOO_LARGE` | `put` (ou `temporaryUploadUrl`) com `maxBytes` definido e um payload / tamanho declarado maior |
| `StorageContentTypeError` | `STORAGE_CONTENT_TYPE` | `put` (ou `temporaryUploadUrl`) com `allowedContentTypes` definido e um content type em falta/fora da lista |
| `UnknownDiskError` | `STORAGE_UNKNOWN_DISK` | `disk('name')` para um disco que não foi declarado |
| `TemporaryUrlUnsupportedError` | `STORAGE_TEMPORARY_URL_UNSUPPORTED` | `temporaryUrl` num driver sem suporte (ex.: `local`) |
| `TemporaryUrlTtlTooLongError` | `STORAGE_TEMPORARY_URL_TTL` (400) | `temporaryUrl` com duração ≤ 0 ou acima de `maxTemporaryUrlTtl` (7 dias por omissão); `temporaryUploadUrl` acima de `maxTemporaryUploadUrlTtl` (1 hora por omissão) |
| `TemporaryUploadUrlUnsupportedError` | `STORAGE_UPLOAD_URL_UNSUPPORTED` | `temporaryUploadUrl` num driver sem suporte (p.ex. `local`), ou uma opção que o backend não consegue ligar (`checksumSha256` em GCS/Azure) |
| `StorageUploadUrlInvalidError` | `STORAGE_UPLOAD_URL_INVALID` (400) | `temporaryUploadUrl` com `contentType` em falta/malformado, `contentLength` não inteiro, `checksumSha256` malformado, ou `maxBytes` sem `contentLength` |
| `StorageTenantRequiredError` | `STORAGE_TENANT_REQUIRED` (400) | Um disco com scope de tenant correu sem tenant no contexto com tenancy registado — resolve um tenant, ou dá a um disco central `scope: null` / `onMissingScope: 'root'` |
| `StorageInvalidScopeError` | `STORAGE_INVALID_SCOPE` | O id do tenant (ou um `scope` próprio) não é um prefixo de path seguro (`..`, uma `/` dentro do id, caracteres de controlo) |
| `ImageProcessingUnavailableError` | `STORAGE_IMAGE_UNAVAILABLE` | Terminal de `disk.image(…)` sem `imageProcessor` configurado |
| `PutStreamUnsupportedError` | `STORAGE_PUT_STREAM_UNSUPPORTED` | `putStream` num driver sem a capacidade — verifica `disk.supports('putStream')` primeiro |
| `GetStreamUnsupportedError` | `STORAGE_GET_STREAM_UNSUPPORTED` | `getStream` num driver sem a capacidade |
| `CopyUnsupportedError` | `STORAGE_COPY_UNSUPPORTED` | `copy({ requireServerSide: true })` sem cópia server-side disponível (um driver diferente, ou um sem `copy`) |
| `StatUnsupportedError` | `STORAGE_STAT_UNSUPPORTED` | `stat` num driver sem a capacidade |
| `StorageStreamLengthRequiredError` | `STORAGE_STREAM_LENGTH_REQUIRED` (400) | `putStream` no S3 sem `contentLength` nem `maxBytes`, e sem o peer opcional `@aws-sdk/lib-storage` que ativa o multipart |
| `StorageSigningEndpointInvalidError` | `STORAGE_SIGNING_ENDPOINT_INVALID` (400) | Um `endpoint` que não é um URL `http(s)` absoluto, ou que traz credenciais, query string ou fragmento |

Todos estendem `BasaltError` e transportam o `code` acima.

## Escrever um driver

Um driver implementa o contrato `StorageDriver` — seis métodos obrigatórios,
mais as capacidades opcionais que conseguir honrar:

```ts
import {
  StorageFileNotFoundError,
  type PutOptions,
  type StorageDriver,
  type TemporaryUploadUrl,
  type TemporaryUploadUrlDriverOptions,
} from '@basaltkit/storage'

export class MyStorageDriver implements StorageDriver {
  readonly name = 'my-backend'
  async put(path: string, content: Buffer | string, options?: PutOptions): Promise<void> { /* … */ }
  async get(path: string): Promise<Buffer> { /* lança StorageFileNotFoundError em miss */ throw 0 }
  async exists(path: string): Promise<boolean> { /* … */ return false }
  async delete(path: string): Promise<boolean> { /* retorna se existia */ return false }
  async list(prefix: string): Promise<string[]> { /* chaves sob o prefixo */ return [] }
  async temporaryUrl(path: string, expiresInMs: number): Promise<string> { /* opcional */ throw 0 }
  // opcional: PUT pré-assinado — liga options.contentType (+ tamanho/checksum) e devolve os headers a enviar
  async temporaryUploadUrl(path: string, expiresInMs: number, options: TemporaryUploadUrlDriverOptions): Promise<TemporaryUploadUrl> { throw 0 }
  // opcional: capacidades para objetos grandes. `source` é UMA Readable do Node
  // que a camada Disk já normalizou e limitou a options.maxBytes.
  async putStream(path: string, source: Readable, options: PutStreamOptions): Promise<void> { /* … */ }
  async getStream(path: string): Promise<Readable> { /* lança StorageFileNotFoundError em miss */ throw 0 }
  async copy(from: string, to: string, options?: CopyDriverOptions): Promise<void> { /* … */ }
  async stat(path: string): Promise<StorageStat> { /* … */ throw 0 }
  async disconnect(): Promise<void> {}
}
```

Deixa de fora o que o teu backend não consegue fazer: o `Disk` reporta a lacuna
com o erro `STORAGE_*_UNSUPPORTED` correspondente e `disk.supports(...)` devolve
`false`. Uma regra não é opcional: um driver que não consiga honrar um
`TemporaryUrlOptions.endpoint` **tem de lançar** em vez de o ignorar — um URL
assinado para o host errado é um URL silenciosamente partido.

Depois liga-o como instância: `disks: { d: { driver: new MyStorageDriver() } }`.
Os drivers de cloud incluídos ([`@basaltkit/storage-gcs`][gcs], [`-azure`][az])
recebem um **cliente injetável**, pelo que a sua lógica é testada unitariamente com um
fake — sem conta de cloud. Faz o mesmo e o teu driver fica testável em CI.

[gcs]: https://github.com/basaltkit/basalt/tree/main/packages/storage-gcs
[az]: https://github.com/basaltkit/basalt/tree/main/packages/storage-azure
