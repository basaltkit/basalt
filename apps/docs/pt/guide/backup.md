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

## Listar e consultar backups

`list()` lê os manifestos JSON do disk configurado, devolve-os do mais recente
para o mais antigo e ignora manifestos incompletos com um aviso:

```ts
const backups = await backup.list()

for (const item of backups) {
  console.log(item.id, item.status, item.target, item.sizeBytes, item.artifact)
}

const ultimoCompleto = backups.find(
  (item) => item.status === 'succeeded' && item.target.kind === 'full',
)
```

Cada `BackupManifest` inclui `id`, `target`, `mode`, `artifact`, `createdAt`,
`completedAt`, `status`, `sizeBytes`, `sha256` e, em caso de falha, `error`.
No CLI:

```bash
pnpm basalt backup:list
```

## Multi-tenancy

- `full` exporta a base PostgreSQL completa.
- `central` exporta o schema `public` por omissão.
- `tenant` exporta o schema derivado por `tenantSchema()`.
- `tenant` com `databaseUrl` exporta uma base individual.

Para `schema-per-tenant`, use:

```ts
await backup.createAllTenants(app.container.get(TENANCY), { concurrency: 5 })
```

O `@basaltkit/backup` não depende de `@basaltkit/tenancy`. Para agendar o
backup de todos os tenants, a aplicação passa explicitamente o seu iterador:

```ts
backupPlugin({
  connectionUrl: process.env.DATABASE_URL!,
  disk: 'backups',
  tenancy: app.container.get(TENANCY),
  schedule: {
    target: 'all-tenants',
    cron: '0 3 * * *',
  },
})
```

O contrato é estrutural, portanto a aplicação pode fornecer o seu próprio
registo de tenants sem instalar o pacote de tenancy do BasaltKit.

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
num container, injete um runner da aplicação. O ponto importante é que o dump
custom é binário: remova o argumento `--file` que aponta para o host e escreva o
stdout de `docker exec` em `options.output`.

```ts
import { createWriteStream } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { PostgresBackup } from '@basaltkit/backup'

const execFileAsync = promisify(execFile)
const container = process.env.POSTGRES_CONTAINER ?? 'postgres'

const dockerRunner = async (command, args, options) => {
  if (command === 'pg_dump' && options.output) {
    const dumpArgs = args.filter((arg, index) =>
      arg !== '--file' && args[index - 1] !== '--file',
    )
    await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', ['exec', container, command, ...dumpArgs], {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const output = createWriteStream(options.output)
      let error = ''
      child.stdout.pipe(output)
      child.stderr.on('data', (chunk) => { error += chunk.toString() })
      child.on('error', reject)
      child.on('close', (code) => code === 0
        ? resolve()
        : reject(new Error(error.trim())))
    })
    return
  }

  // O pg_restore recebe um caminho temporário do host; copie-o para o container.
  const input = args.at(-1)
  if (command === 'pg_restore' && input) {
    const remoteInput = `/tmp/basalt-${Date.now()}.dump`
    await execFileAsync('docker', ['cp', input, `${container}:${remoteInput}`])
    try {
      await execFileAsync('docker', [
        'exec', container, command, ...args.slice(0, -1), remoteInput,
      ])
    } finally {
      await execFileAsync('docker', ['exec', container, 'rm', '-f', remoteInput])
    }
    return
  }

  await execFileAsync('docker', ['exec', container, command, ...args], {
    cwd: options.cwd,
  })
}

const backup = new PostgresBackup({
  connectionUrl: process.env.DATABASE_URL!,
  disk: app.container.get(STORAGE).disk('backups'),
  runner: dockerRunner,
})
```

A URL como `localhost:5433` no host pode ser `localhost:5432` dentro do
container PostgreSQL. O `PostgresBackup` remove o parâmetro Prisma `schema`
antes de chamar as ferramentas PostgreSQL. Nomes de containers, pods e
credenciais ficam fora do pacote.

### Parâmetros do runner

| Parâmetro | Tipo | Significado |
| --- | --- | --- |
| `command` | `string` | `pg_dump` ou `pg_restore`. |
| `args` | `string[]` | Argumentos da ferramenta; não construa uma string shell. |
| `options.cwd` | `string` | Diretório temporário no host da aplicação. |
| `options.output` | `string \| undefined` | Caminho no host onde o runner Docker escreve o stdout binário do `pg_dump`. |

### Opções do backup

| Opção | Padrão | Significado |
| --- | --- | --- |
| `connectionUrl` | obrigatório | URL PostgreSQL. |
| `disk` | obrigatório | Disk local ou compatível com S3. |
| `prefix` | `backups` | Prefixo dos dumps e manifestos. |
| `pgDumpPath` / `pgRestorePath` | `pg_dump` / `pg_restore` | Nome ou caminho das ferramentas. |
| `tenantSchemaPrefix` | `tenant_` | Prefixo dos schemas por tenant. |
| `tenantDatabaseUrl` | nenhum | Callback para URLs database-per-tenant. |
| `retention` | nenhum | Número de backups concluídos mantidos por target. |
| `runner` | subprocesso local | Execução personalizada em Docker, Kubernetes ou sidecar. |
| `logger` | nenhum | Logs de ciclo de vida e falhas. |

Não existe um método público `prune()`. `retention` mantém automaticamente os
backups concluídos mais recentes por target. A limpeza corre no fim de cada
`create()` bem-sucedido:

```ts
const backup = new PostgresBackup({
  connectionUrl: process.env.DATABASE_URL!,
  disk,
  retention: 7,
})
```

Isto mantém sete backups completos, sete centrais e sete backups por tenant,
independentemente. Falhas não consomem o limite. Sem `retention`, a limpeza
automática fica desativada.

Para restaurar, primeiro consulte a lista e passe o id do manifesto:

```ts
const backups = await backup.list()
const candidato = backups.find(
  (item) => item.status === 'succeeded' && item.target.kind === 'full',
)
if (!candidato) throw new Error('Não existe um backup completo concluído')

await backup.restore(candidato.id, process.env.RESTORE_DATABASE_URL!, {
  confirm: async () => process.env.CONFIRM_RESTORE === 'yes',
  environment: process.env.NODE_ENV,
})
```

`restore()` descarrega o artefacto para um ficheiro temporário, executa
`pg_restore` com `--clean --if-exists --no-owner --exit-on-error` e remove o
ficheiro depois. A produção exige `allowProduction: true`; uma confirmação
falsa é recusada. Teste sempre numa base descartável antes de substituir a base
live.