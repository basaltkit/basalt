# Backups PostgreSQL

O `@basaltkit/backup` fornece backups PostgreSQL para aplicações Basalt sem
acoplar o framework a uma infraestrutura específica. Executa `pg_dump` e
`pg_restore`, guarda dumps e manifestos JSON através de um `Disk` Basalt e
funciona com disco local, S3, MinIO e serviços compatíveis com S3.

[[toc]]

## Instalação

```bash
pnpm add @basaltkit/backup @basaltkit/storage
```

O runtime precisa de `pg_dump` e `pg_restore`, ou de um `runner` personalizado.
O PostgreSQL pode estar localmente, num Docker, Kubernetes ou num fornecedor
gerido. O pacote não assume onde a base de dados corre.

## Configurar o storage

Use um disk dedicado com `scope: null`. Um backup contém dados da aplicação
inteira e não deve herdar o prefixo do tenant do pedido:

```ts
storagePlugin({
  disks: {
    backups: { driver: 'local', root: './backups', scope: null },
  },
})
```

Para MinIO, AWS S3, R2 ou outro serviço compatível, use `@basaltkit/storage-s3`
com `s3Disk({ bucket, endpoint, credentials, scope: null })`.

## Onde ficam os ficheiros

S3/MinIO é opcional. O destino é escolhido pelo `Disk` do backup:

- um disk local escreve os dumps e manifestos na raiz configurada do
  filesystem;
- um disk compatível com S3 escreve no bucket configurado;
- configurar S3 para os documentos não configura S3 automaticamente para os
  backups. O disk de backups tem de usar explicitamente `s3Disk(...)`.

O prefixo padrão dos artefactos é `backups/`. Num bucket S3, verá chaves como:

```text
backups/32288d74-e732-4657-a685-1c77193adab3.dump
backups/32288d74-e732-4657-a685-1c77193adab3.json
```

Com um disk local cuja raiz é `./backups`, o mesmo prefixo produz ficheiros em
`./backups/backups/`. Escolha outra raiz se quiser os ficheiros diretamente
dentro de uma única pasta `./backups`.

No demo OfficeLaw, `BACKUP_BUCKET` controla esta escolha: vazio significa disk
local; preenchido juntamente com `S3_ENDPOINT` significa S3/MinIO. O bootstrap
do demo cria o bucket quando necessário. Depois de alterar estas variáveis,
reinicie a aplicação, porque o disk é escolhido durante o boot.

Para verificar S3/MinIO, liste o bucket configurado e procure o prefixo
`backups/`. Para verificar o modo local, liste a raiz do disk a partir da mesma
pasta usada para iniciar a aplicação.

## Criar backups

```ts
backupPlugin({
  connectionUrl: process.env.DATABASE_URL!,
  disk: 'backups',
  retention: 7,
})

const backup = app.container.get(BACKUP)
await backup.create({ kind: 'full' })
await backup.create({ kind: 'central' })
```

Cada execução cria um dump em formato custom e um manifesto JSON com estado,
target, datas, tamanho e checksum SHA-256. Execuções falhadas permanecem
visíveis como manifestos `failed` e são registadas com o id do backup.

## Multi-tenancy

- `full` exporta a base PostgreSQL completa.
- `central` exporta o schema `public` por omissão.
- `tenant` exporta o schema derivado por `tenantSchema()`.
- `tenant` com `databaseUrl` exporta uma base individual.

Para `schema-per-tenant`, use:

```ts
await backup.createAllTenants(app.container.get(TENANCY), { concurrency: 5 })
```

Para `database-per-tenant`, configure `tenantDatabaseUrl` ou passe um
`databaseUrl` por target.

## Scheduler existente

O plugin adiciona uma entrada ao `Scheduler` já registado por
`schedulerPlugin`; não cria outro processo cron:

```ts
backupPlugin({
  connectionUrl: process.env.DATABASE_URL!,
  disk: 'backups',
  schedule: {
    name: 'backup:postgres',
    target: [{ kind: 'full' }, { kind: 'central' }, 'all-tenants'],
    cron: '0 3 * * *',
  },
})
```

Execução manual através do scheduler:

```bash
pnpm basalt schedule:run backup:postgres
```

Também é possível chamar `PostgresBackup.create()` diretamente dentro do
`define` do `schedulerPlugin` quando a aplicação centraliza todas as tarefas.

## Docker, retenção e restore

O runner padrão executa `pg_dump` no runtime da aplicação. Se o binário estiver
num container, injete um runner da aplicação que capture o stdout binário para o
ficheiro temporário. Nomes de containers e credenciais ficam fora do pacote.

`retention` mantém os backups concluídos mais recentes por target. O
`restore()` exige confirmação explícita e recusa produção sem
`allowProduction: true`. Teste sempre o restore numa base descartável antes de
substituir a base live.