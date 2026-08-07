# @machize/files

Pipeline de **uploads** para o Machize, sobre o [`@machize/storage`](https://www.npmjs.com/package/@machize/storage): valida (tipo/tamanho), aplica **quota por tenant**, guarda os bytes, grava metadados, e dispara **hooks** (antivírus, thumbnails). Precisas deste módulo quando os utilizadores enviam ficheiros — anexos, avatares, documentos — e queres fazê-lo com segurança e isolamento por tenant.

## O que este módulo resolve

Guardar um upload "à mão" envolve validar o tipo/tamanho, escrever no armazenamento no sítio certo (isolado por tenant), registar metadados (nome, tamanho, checksum, quem enviou), controlar a quota do plano, e desencadear pós-processamento (análise antivírus, miniaturas). Este módulo faz tudo isso numa chamada, deixando o pós-processamento para hooks.

## Instalação

```bash
pnpm add @machize/files @machize/storage
```

Depende do `@machize/core`, `@machize/storage` e `@machize/fastify` (rotas). Configura um disco no `@machize/storage` (local em dev, S3/GCS em produção).

## Começar em 5 minutos

```ts
import { createApp } from '@machize/core'
import { filesPlugin, FILES, fileRoutes } from '@machize/files'
import { fastifyPlugin } from '@machize/fastify'

const app = await createApp({
  plugins: [
    // ... storagePlugin({ disks: { uploads: ... } }) e tenancyPlugin
    filesPlugin({
      disk: 'uploads',                         // nome do disco (ou uma instância Disk)
      validate: { maxSize: 5_000_000, allowedTypes: ['image/*', 'application/pdf'] },
      maxTotalBytes: 1_000_000_000,            // quota por tenant (1 GB)
    }),
    fastifyPlugin({ routes: [...fileRoutes()] }),
  ],
}).boot()

const files = app.container.get(FILES)
const record = await files.upload(buffer, { name: 'contrato.pdf', contentType: 'application/pdf', tenantId: 'acme', uploadedBy: 'u1' })
```

O upload valida, verifica a quota, escreve os bytes **isolados por tenant**, grava os metadados (incluindo `checksum` SHA-256) e emite `file:uploaded`.

## Receber um upload por HTTP

O upload em si é *multipart* (específico do adapter), por isso não há uma rota pronta. No teu handler, lê o ficheiro e chama o serviço:

```ts
// exemplo Fastify com @fastify/multipart
app.post('/upload', async (req) => {
  const part = await req.file()
  const buffer = await part.toBuffer()
  return files.upload(buffer, { name: part.filename, contentType: part.mimetype })
  // tenantId vem do contexto do pedido (tenancy)
})
```

As restantes operações têm rotas prontas via `fileRoutes()`:

| Rota | Descrição |
|---|---|
| `GET /files` | Lista os ficheiros do tenant atual. |
| `GET /files/:id` | Metadados de um ficheiro. |
| `POST /files/:id/url` `{ expiresIn? }` | URL assinado temporário. |
| `DELETE /files/:id` | Apaga bytes + metadados. |

## Pós-processamento com hooks

O padrão típico: ao `file:uploaded`, despacha um job (com o `@machize/queue`) que analisa/processa o ficheiro e depois chama `markScanned`:

```ts
hooks.on('file:uploaded', ({ file }) => ScanFile.dispatch({ tenantId: file.tenantId, id: file.id }))

// no job, depois de analisar:
await files.markScanned(id, { clean: true }, tenantId) // emite file:scanned
```

## Referência da API

### `filesPlugin(options)`

| Opção | Tipo | Descrição |
|---|---|---|
| `disk` | `Disk \| string` | Instância `Disk` ou nome de um disco do `@machize/storage`. |
| `validate` | `{ maxSize?, allowedTypes? }` | Limite de tamanho e tipos permitidos (`image/*` aceita wildcard). |
| `maxTotalBytes` | `number` | Quota total por tenant. |
| `checkQuota` | `(tenantId, size) => void` | Verificação de quota personalizada (ex.: ligar ao `@machize/subscriptions`). Lança para recusar. |
| `store` | `FileStore` | Persistência de metadados. Default: em memória. |

Regista o token `FILES`.

### `class Files`

| Método | Descrição |
|---|---|
| `upload(content, input)` | Valida, aplica quota, guarda, grava metadados, emite `file:uploaded`. |
| `download(id, tenantId?)` | `{ record, content }`. |
| `temporaryUrl(id, expiresIn, tenantId?)` | URL assinado. |
| `get(id, tenantId?)` · `list(tenantId?)` | Metadados. |
| `delete(id, tenantId?)` | Apaga bytes + metadados; emite `file:deleted`. |
| `markScanned(id, result, tenantId?)` | Marca como analisado; emite `file:scanned`. |

Sem `tenantId` explícito, usa `ctx().tenant.id`; sem tenant, lança `FileTenantRequiredError`. O acesso ao armazenamento corre no contexto do tenant resolvido, por isso os ficheiros ficam isolados mesmo a partir de um job em segundo plano.

Erros: `FileTooLargeError` (413), `FileTypeNotAllowedError` (415), `StorageQuotaExceededError` (402), `FileNotFoundError` (404).

## Como se liga aos outros módulos

- **`@machize/storage`** — onde os bytes ficam (local/S3/GCS), com isolamento por tenant.
- **`@machize/subscriptions`** — liga `checkQuota` a `features(tenant).consume(...)` para quota por plano.
- **`@machize/queue`** — processa `file:uploaded` fora do pedido (antivírus, miniaturas).
- **`@machize/tenancy`** — fornece o tenant do contexto.
