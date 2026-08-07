# @machize/storage

Camada de armazenamento de ficheiros do Machize: guarda, lê e apaga ficheiros (uploads, relatórios, imagens, faturas…) com a mesma API, quer estejam no disco local, quer num serviço na nuvem compatível com S3 (AWS S3, MinIO, Cloudflare R2). Precisas deste módulo sempre que a tua aplicação lida com ficheiros.

## O que este módulo resolve

Guardar ficheiros parece simples até precisares de mudar de sítio: em desenvolvimento queres uma pasta no teu computador; em produção queres um serviço de **object storage** (armazenamento de objetos — serviços como o AWS S3 que guardam ficheiros num **bucket**, uma espécie de "pasta na nuvem" com nome único). Sem uma camada de abstração, o código fica cheio de `fs.writeFile` num sítio e chamadas ao SDK da AWS noutro.

Este módulo define um contrato único (`StorageDriver`) com dois **drivers** (implementações intercambiáveis): `local` (sistema de ficheiros) e `s3` (qualquer serviço compatível com S3). O teu código fala sempre com um **`Disk`** — um "disco" com nome (ex.: `uploads`, `invoices`) — e trocar de driver é só mudar configuração, nunca código.

Também resolve dois problemas importantes de aplicações SaaS: **isolamento por tenant** (cada cliente/organização só vê os seus próprios ficheiros, guardados automaticamente sob `tenants/<id>/…`) e **URLs temporários assinados** (links de download que expiram — ex.: "este link para o PDF é válido durante 15 minutos" — sem tornar o bucket público). O driver local ainda bloqueia *path traversal* (tentativas de escapar da pasta raiz com `../`).

## Instalação

```bash
pnpm add @machize/storage
```

Depende de `@machize/core` e já inclui o SDK da AWS (`@aws-sdk/client-s3`) — não precisas de instalar mais nada, mesmo que só uses o driver local.

## Começar em 5 minutos

1. **Regista o plugin** com pelo menos um disco. Começa pelo driver `local`, que só precisa de uma pasta.
2. **Obtém o `Storage`** através do token `STORAGE` e escolhe um disco.
3. **Guarda e lê ficheiros.**

```ts
import { createApp } from '@machize/core'
import { STORAGE, storagePlugin } from '@machize/storage'

// 1. Um disco chamado 'uploads', guardado na pasta ./storage do projeto
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

// 2. Obtém o serviço de storage e o disco por omissão
const storage = app.container.get(STORAGE)
const disk = storage.disk() // 'uploads', porque é o default

// 3. Escreve, lê, verifica e apaga
await disk.put('docs/bemvindo.txt', 'Olá!')
const conteudo = await disk.get('docs/bemvindo.txt') // Buffer
console.log(conteudo.toString())                     // 'Olá!'
console.log(await disk.exists('docs/bemvindo.txt'))  // true
await disk.delete('docs/bemvindo.txt')

await app.shutdown()
```

Para produção com S3/MinIO, muda apenas a configuração do disco:

```ts
storagePlugin({
  default: 'uploads',
  disks: {
    uploads: {
      driver: 's3',
      bucket: 'a-minha-app',
      region: 'eu-west-1',
      // Para MinIO ou outro serviço compatível com S3:
      // endpoint: 'http://localhost:9000',
      credentials: { accessKeyId: '…', secretAccessKey: '…' },
    },
  },
})
```

## Guia de utilização

### Escrever e ler ficheiros

```ts
import { Disk, LocalStorageDriver } from '@machize/storage'

const disk = new Disk('uploads', new LocalStorageDriver({ root: './storage' }), { scope: null })

// Aceita strings e Buffers; as pastas intermédias são criadas automaticamente
await disk.put('docs/leia-me.txt', 'olá')
await disk.put('img/pixel.bin', Buffer.from([1, 2, 3]))

// No driver S3 podes indicar o tipo de conteúdo (Content-Type)
await disk.put('relatorio.pdf', pdfBuffer, { contentType: 'application/pdf' })

// get devolve sempre um Buffer (bytes crus); converte para texto se precisares
const texto = (await disk.get('docs/leia-me.txt')).toString()
```

### Listar, verificar e apagar

```ts
await disk.put('a/1.txt', 'x')
await disk.put('a/b/2.txt', 'y')

await disk.list('a')          // ['a/1.txt', 'a/b/2.txt'] — recursivo, ordenado
await disk.list()             // todos os ficheiros do disco (dentro do scope atual)
await disk.exists('a/1.txt')  // true
await disk.delete('a/1.txt')  // true (existia e foi apagado)
await disk.delete('a/1.txt')  // false (já não existia)
```

### Vários discos com nomes

Podes declarar quantos discos quiseres — por exemplo, uploads públicos num bucket e faturas noutro:

```ts
import { createApp } from '@machize/core'
import { STORAGE, storagePlugin } from '@machize/storage'

const app = await createApp({
  plugins: [
    storagePlugin({
      default: 'uploads',
      disks: {
        uploads: { driver: 'local', root: './storage/uploads' },
        invoices: { driver: 's3', bucket: 'faturas-empresa', region: 'eu-west-1' },
      },
    }),
  ],
}).boot()

const storage = app.container.get(STORAGE)
await storage.disk().put('avatar.png', imagem)              // disco default ('uploads')
await storage.disk('invoices').put('2026/01.pdf', fatura)   // disco pelo nome
```

### URLs temporários (downloads seguros)

Um **URL assinado** é um link com uma assinatura criptográfica e um prazo de validade — permite dar acesso a um ficheiro privado sem expor o bucket. Só o driver `s3` suporta esta funcionalidade:

```ts
// Válido durante 15 minutos; depois disso o link deixa de funcionar
const url = await storage.disk('invoices').temporaryUrl('2026/01.pdf', '15m')
```

O prazo aceita milissegundos ou strings como `'500ms'`, `'30s'`, `'15m'`, `'2h'`, `'7d'`. No driver `local` esta chamada lança `TemporaryUrlUnsupportedError`.

### Isolamento automático por tenant

Tal como na cache, cada operação lê o tenant do contexto do pedido e prefixa os caminhos com `tenants/<id>/`. Cada tenant tem a sua área privada sem escreveres uma linha extra:

```ts
import { runWithContext } from '@machize/core'
import { Disk, LocalStorageDriver } from '@machize/storage'

const disk = new Disk('uploads', new LocalStorageDriver({ root: './storage' }))

await runWithContext({ tenant: { id: 'acme' } }, () => disk.put('logo.png', 'logo-da-acme'))
await runWithContext({ tenant: { id: 'globex' } }, () => disk.put('logo.png', 'logo-da-globex'))
await disk.put('logo.png', 'logo-central') // fora de qualquer tenant

// Cada tenant lê o SEU logo.png:
//   acme   → tenants/acme/logo.png
//   globex → tenants/globex/logo.png
//   sem tenant → logo.png
```

Nos pedidos HTTP normais não precisas de `runWithContext` — o framework coloca o tenant no contexto por ti. Para desativar, configura o disco com `scope: null`.

## Referência da API

### `class Disk`

`new Disk(name: string, driver: StorageDriver, options?: DiskOptions)`

| Método | Assinatura | Descrição |
|---|---|---|
| `put` | `put(path: string, content: Buffer \| string, options?: PutOptions): Promise<void>` | Escreve um ficheiro (cria pastas intermédias). |
| `get` | `get(path: string): Promise<Buffer>` | Lê um ficheiro; lança `StorageFileNotFoundError` se não existir. |
| `exists` | `exists(path: string): Promise<boolean>` | Verifica se o ficheiro existe. |
| `delete` | `delete(path: string): Promise<boolean>` | Apaga; `true` se existia. |
| `list` | `list(prefix?: string): Promise<string[]>` | Lista caminhos sob o prefixo (recursivo, ordenado). Default do prefixo: `''`. |
| `temporaryUrl` | `temporaryUrl(path: string, expiresIn: DurationInput): Promise<string>` | URL pré-assinado; lança `TemporaryUrlUnsupportedError` se o driver não suportar. |

#### `DiskOptions`

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `scope` | `(() => string \| undefined) \| null` | Não | lê `ctx().tenant.id` → `tenants/<id>` | Prefixo dinâmico de caminho, resolvido em cada operação. `null` desativa. |

#### `PutOptions`

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `contentType` | `string` | Não | — | Content-Type do ficheiro (usado pelo driver `s3`; ignorado pelo `local`). |

### `class Storage`

`new Storage(defaultDisk?: string)`

| Método | Assinatura | Descrição |
|---|---|---|
| `add` | `add(disk: Disk): this` | Regista um disco (encadeável). |
| `disk` | `disk(name?: string): Disk` | Devolve o disco pelo nome; sem argumento devolve o default (ou o primeiro registado). Lança `UnknownDiskError` se não existir. |

### `storagePlugin(options: StoragePluginOptions)`

Regista o `Storage` no contentor sob o token `STORAGE` e desconecta todos os drivers no `shutdown`.

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `disks` | `Record<string, DiskConfig>` | Sim | — | Mapa nome-do-disco → configuração. |
| `default` | `string` | Não | primeiro disco registado | Disco devolvido por `storage.disk()` sem argumento. |

#### `DiskConfig`

Uma de duas formas (ambas aceitam também `scope` de `DiskOptions`):

- `{ driver: 'local', root: string }` — `root` é a pasta raiz no sistema de ficheiros.
- `{ driver: 's3', ...S3DriverOptions }` — ver abaixo.

### `STORAGE`

Token de injeção de dependências: `app.container.get(STORAGE)` devolve o `Storage`.

### `class S3StorageDriver` (Avançado)

`new S3StorageDriver(options: S3DriverOptions)` — funciona com AWS S3, MinIO, Cloudflare R2 e outros serviços compatíveis.

#### `S3DriverOptions`

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `bucket` | `string` | Sim | — | Nome do bucket. |
| `region` | `string` | Não | `'us-east-1'` | Região AWS. |
| `endpoint` | `string` | Não | — | Endpoint personalizado — define isto para usar MinIO/R2. |
| `credentials` | `{ accessKeyId: string; secretAccessKey: string }` | Não | credenciais do ambiente AWS | Credenciais explícitas. |
| `forcePathStyle` | `boolean` | Não | `true` quando há `endpoint`, senão `false` | URLs no formato `http://host/bucket/chave` (exigido pelo MinIO). |

### `class LocalStorageDriver` (Avançado)

`new LocalStorageDriver(options: { root: string })` — guarda no sistema de ficheiros, com `root` resolvido para caminho absoluto. Rejeita caminhos que tentem sair da raiz (lança `StorageInvalidPathError`). Não suporta `temporaryUrl`.

### `interface StorageDriver` (Avançado)

Contrato para criares o teu próprio driver: `name` (string legível, usada nos erros), `put`, `get`, `exists`, `delete`, `list`, `temporaryUrl?` (opcional, recebe o prazo em milissegundos) e `disconnect`.

### Erros exportados

| Classe | Código | Quando acontece |
|---|---|---|
| `StorageFileNotFoundError` | `STORAGE_FILE_NOT_FOUND` | `get` de um ficheiro que não existe. |
| `StorageInvalidPathError` | `STORAGE_INVALID_PATH` | Caminho tenta sair da raiz do disco (`../…`). |
| `UnknownDiskError` | `STORAGE_UNKNOWN_DISK` | `storage.disk('nome')` de um disco não declarado. |
| `TemporaryUrlUnsupportedError` | `STORAGE_TEMPORARY_URL_UNSUPPORTED` | `temporaryUrl` num driver sem suporte (ex.: `local`). |

Todos estendem `MachizeError` de `@machize/core` e têm uma propriedade `code` com o código acima.

## Erros comuns e soluções (FAQ)

**`get` lança `STORAGE_FILE_NOT_FOUND` mas eu acabei de gravar o ficheiro.**
Quase de certeza que gravaste e leste em contextos de tenant diferentes: com o scope por omissão, o mesmo `logo.png` vive em `tenants/acme/logo.png` para um tenant e em `logo.png` fora de tenant. Confirma o contexto ou usa `scope: null`.

**`STORAGE_INVALID_PATH` ao usar `../` no caminho.**
É intencional: o driver local bloqueia qualquer caminho que saia da pasta raiz — é uma proteção de segurança contra *path traversal*. Usa sempre caminhos relativos dentro do disco.

**`Unknown disk "x"` ao chamar `storage.disk('x')`.**
O disco tem de ser declarado em `storagePlugin({ disks: { x: … } })`. Verifica o nome (é sensível a maiúsculas/minúsculas).

**`temporaryUrl` falha com "does not support temporary URLs".**
O driver `local` não consegue gerar URLs assinados — isso é uma funcionalidade do S3. Em desenvolvimento, serve os ficheiros por uma rota da tua aplicação, ou usa MinIO localmente com um disco `s3`.

**Com MinIO recebo erros de ligação ou de bucket.**
Define `endpoint: 'http://localhost:9000'` (ou o teu endereço). O `forcePathStyle` passa automaticamente a `true` quando há endpoint — não precisas de o definir. Confirma que o bucket já existe no MinIO.

**`get` devolve um `Buffer`, eu queria texto/JSON.**
Um `Buffer` são bytes crus. Converte: `buffer.toString()` para texto, `JSON.parse(buffer.toString())` para JSON.

## Como se liga aos outros módulos

- **`@machize/core`** — fornece o `createApp`, o contentor, o contexto de pedido (de onde vem o isolamento por tenant), o `parseDuration` dos prazos e a classe base `MachizeError`.
- **`@machize/tenancy`** — com o plugin de tenancy a identificar o tenant de cada pedido, os discos isolam os ficheiros por tenant automaticamente.
- **`@machize/http` / `@machize/express` / `@machize/fastify` / `@machize/hono`** — nas rotas de upload/download, obténs o `Storage` do contentor e usas `disk.put`/`disk.get`/`disk.temporaryUrl`.
- **`@machize/prisma`** — padrão comum: guardar o ficheiro num disco e o caminho/metadados na base de dados.
