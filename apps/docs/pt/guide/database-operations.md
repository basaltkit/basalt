# Operações de base de dados

Um SaaS com um schema (ou uma base de dados) por tenant tem **dois planos de
migração**: a base central e a de cada tenant. O Prisma Migrate corre cada um
deles; o Basalt acrescenta o que o Prisma não diz — o que significa uma falha, e
em que estado está cada plano — e deixa o resto aos comandos `prisma` de sempre.

Esta página cobre os erros que aparecem numa manhã má, um `db:status` só de
leitura para a CI, e uma receita idempotente para os grants e extensões que as
migrações não conseguem manter no sítio.

## O que os erros significam

`describeDbError(error)` do `@basaltkit/prisma` traduz uma falha de base de dados
numa causa e numa correcção de uma linha. O `assertMigrated` (e portanto o
`prismaPlugin({ assertMigrated: true })`), o `tenant:migrate` e o `db:status`
usam-no, e o `bin/basalt.ts` e o `src/server.ts` gerados pelo scaffold mostram a
correcção em vez de um stack trace nu.

| Código | O que vês | Significa | Correcção |
| --- | --- | --- | --- |
| `DB_PERMISSION_DENIED` | `permission denied for schema public` (SQLSTATE `42501`, também dentro do Prisma `P2010`), `P1010` | Falta um privilégio ao role da app — tipicamente perdido quando o `public` foi apagado e recriado (um reset, um restauro parcial). A migração que o concedeu já está registada, por isso nada o volta a aplicar | `GRANT USAGE ON SCHEMA public TO <role>;` — o role vem do URL ou da ligação. Depois torna os grants um [passo pós-deploy](#os-grants-e-as-extensoes-sao-estado-nao-historia) |
| `DB_NOT_EMPTY_BASELINE` | `P3005 The database schema is not empty` | O `migrate deploy` recusa uma base que tem tabelas mas não tem histórico de migrações | Baseline: `prisma migrate resolve --applied <migração>` para cada migração já reflectida no schema, depois `prisma migrate deploy` |
| `DB_UNREACHABLE` | `P1001`, `ECONNREFUSED`, `ENOTFOUND`, `P1000`, `P1003` | O servidor está em baixo ou o URL está errado (host, porta, credenciais, nome da base) | Verifica o `DATABASE_URL`, arranca a base de dados |
| `DB_NOT_MIGRATED` | `P2021`, `relation "…" does not exist` | As tabelas não existem: nunca migrada, ou a base errada | `prisma migrate deploy` (central), `pnpm basalt tenant:migrate` (tenants) |

```ts
import { describeDbError } from '@basaltkit/prisma'

try {
  await db.project.findMany()
} catch (error) {
  const diagnosis = describeDbError(error, { url: process.env.DATABASE_URL })
  if (diagnosis) logger.error(`${diagnosis.cause} Fix: ${diagnosis.fix}`)
  throw error
}
```

Devolve `undefined` para tudo o resto (um erro de unicidade não é um problema de
operações), e retira as credenciais de todas as mensagens que cita.

No PostgreSQL, um role **sem USAGE sobre um schema não recebe "permission
denied"** para um nome de tabela não qualificado — o schema apenas sai do
`search_path`, e a tabela "não existe". O `assertMigrated` verifica o catálogo
para este caso, por isso um grant revogado é reportado como
`DB_PERMISSION_DENIED` com o `GRANT`, e não como uma base por migrar. O erro
mantém o código `PRISMA_NOT_MIGRATED`; `error.details.diagnosis` traz
`{ code, cause, fix }`.

## `db:status` — em que estado está cada plano

`dbStatusCommand()` constrói um `basalt db:status` **só de leitura**: corre
`prisma migrate status` para o plano central e para cada tenant, imprime uma
linha por plano com a correcção para o que estiver mal, e **sai com 1** quando
alguma coisa está pendente, falhada, divergente ou inacessível.

```ts
import { commandsPlugin } from '@basaltkit/cli'
import { dbStatusCommand, tenantMigrateCommand } from '@basaltkit/prisma'

const target = { mode: 'schema', url: process.env.DATABASE_URL! } as const
const tenantIds = async () => (await tenants.list()).map((tenant) => tenant.id)

commandsPlugin([
  tenantMigrateCommand({ tenants: tenantIds, target }),
  dbStatusCommand({
    central: { configPath: 'prisma.config.ts' },
    tenants: { list: tenantIds, target, configPath: 'prisma/tenant/prisma.config.ts' },
  }),
])
```

```sh
$ pnpm basalt db:status
ok   central: up to date
ok   tenant acme (tenant_acme): up to date
FAIL tenant globex (tenant_globex): 2 pending — 20260901_invoices, 20260915_tags
       fix: Run the migrations for this plane.
Not up to date. Tenants: 1 up to date, 1 not.
```

`--json` imprime `{ ok, planes: [{ plane, tenantId?, schema?, state, pending?, detail?, fix? }] }`.
Corre-o na CI depois do passo de deploy — ou antes, para recusar um deploy sobre
uma base divergente. Nunca aplica, provisiona, faz baseline nem concede nada.

## Os grants e as extensões são estado, não história

Uma migração corre uma vez. Tudo o que recria o `public` — um reset, um restauro
parcial, um `DROP SCHEMA` à mão — leva consigo os grants do role da app e as
extensões, e a migração que os criou já está registada como aplicada. Uma segunda
migração tem a mesma fraqueza assim que fica registada.

Mantém-nos num **ficheiro SQL idempotente** corrido em cada deploy, depois do
`prisma migrate deploy`, como dono da base:

```sql
-- prisma/post-deploy.sql — seguro de correr quantas vezes for preciso
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;

-- o que o role de runtime NÃO pode ter, dito com a mesma clareza
REVOKE UPDATE, DELETE ON audit_log FROM app_runtime;
```

```sh
prisma migrate deploy
psql "$DATABASE_OWNER_URL" -v ON_ERROR_STOP=1 -f prisma/post-deploy.sql
pnpm basalt tenant:migrate
pnpm basalt db:status
```

O Basalt não traz de propósito uma DSL para isto: a topologia de grants (que
roles, que tabelas, o que é revogado) é política de deploy, e o SQL já a diz com
exactidão.

## Baselines e migrações novas continuam a ser Prisma simples

Não há wrapper `db:baseline` nem `db:new`. Os comandos do próprio Prisma fazem-no,
e um wrapper só os esconderia:

- **Migração nova**: `prisma migrate dev --name <nome>` (central), ou com o
  `--config` do plano dos tenants (ver [Base de dados por tenant](/pt/guide/database-per-tenant#onde-vivem-as-migracoes-dos-tenants)).
- **Baseline de uma base existente**: `prisma migrate resolve --applied <migração>`
  por cada migração já presente, depois `prisma migrate deploy`.

Ver também: [Padrão multi-tenant](/pt/guide/multi-tenant-pattern) para um schema
e uma config por plano, e [Produção](/pt/guide/production) para as verificações
de boot.
