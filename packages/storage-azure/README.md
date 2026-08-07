# @machize/storage-azure

Driver de **Azure Blob Storage** para o [`@machize/storage`](https://www.npmjs.com/package/@machize/storage): guarda ficheiros no Azure Blob sem mudar o código da app. Precisas deste módulo quando corres no Azure e queres Blob Storage em vez de S3, GCS ou disco local.

## Instalação

```bash
pnpm add @machize/storage-azure @azure/storage-blob
```

O `@azure/storage-blob` é uma **peer dependency**.

## Uso

```ts
import { storagePlugin } from '@machize/storage'
import { AzureBlobStorageDriver } from '@machize/storage-azure'

storagePlugin({
  disks: {
    uploads: {
      driver: new AzureBlobStorageDriver({ container: 'uploads', connectionString: process.env.AZURE_STORAGE_CONNECTION_STRING }),
    },
  },
})
```

Implementa o contrato `StorageDriver` — `put`, `get`, `exists`, `delete`, `list` e **URLs assinados** (SAS via `temporaryUrl`). O isolamento por tenant é automático via `Disk`.

## Testável sem cloud

O container é **injetável**, por isso a lógica do driver testa-se com um fake — sem Azure:

```ts
new AzureBlobStorageDriver({ container: 'c', client: fakeContainer })
```

## Como se liga aos outros módulos

- **`@machize/storage`** — este é um driver desse pacote; a API (`Disk`, `storagePlugin`) vem de lá.
- Drivers irmãos: `S3StorageDriver` (no core) e [`@machize/storage-gcs`](https://www.npmjs.com/package/@machize/storage-gcs).
