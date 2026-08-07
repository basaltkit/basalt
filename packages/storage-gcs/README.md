# @machize/storage-gcs

Driver de **Google Cloud Storage** para o [`@machize/storage`](https://www.npmjs.com/package/@machize/storage): guarda ficheiros no GCS sem mudar o código da app. Precisas deste módulo quando corres no Google Cloud e queres GCS em vez de S3 ou disco local.

## Instalação

```bash
pnpm add @machize/storage-gcs @google-cloud/storage
```

O `@google-cloud/storage` é uma **peer dependency**. Credenciais pela cadeia padrão do GCP (ADC, `keyFilename`, service account).

## Uso

```ts
import { storagePlugin } from '@machize/storage'
import { GcsStorageDriver } from '@machize/storage-gcs'

storagePlugin({
  disks: { uploads: { driver: new GcsStorageDriver({ bucket: 'my-bucket', projectId: 'my-project' }) } },
})
```

Implementa o contrato `StorageDriver` — `put`, `get`, `exists`, `delete`, `list` e **URLs assinados** (`temporaryUrl`). Como todos os discos do Machize, o isolamento por tenant é automático via `Disk`.

## Testável sem cloud

O cliente (bucket) é **injetável**, por isso a lógica do driver testa-se com um fake — sem GCS:

```ts
new GcsStorageDriver({ bucket: 'b', client: fakeBucket })
```

## Como se liga aos outros módulos

- **`@machize/storage`** — este é um driver desse pacote; a API (`Disk`, `storagePlugin`) vem de lá.
- Drivers irmãos: `S3StorageDriver` (no core) e [`@machize/storage-azure`](https://www.npmjs.com/package/@machize/storage-azure).
