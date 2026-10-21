# Base de dados

A tua app tem dois tipos de dados. Os da framework — utilizadores, sessões,
tenants, membros das equipas — vivem atrás de contratos de store, tratados em
[Persistência & stores duráveis](/pt/guide/persistence). **Os teus** — produtos,
encomendas, faturas, aquilo de que a app trata — vivem em tabelas que tu
desenhas. Esta página é sobre o segundo tipo, e mostra os dois juntos, porque um
projeto real precisa de ambos na mesma base de dados.

Há três formas de os guardar:

| | Em memória | SQLite | PostgreSQL (Prisma) |
| --- | --- | --- | --- |
| Sobrevive a um reinício | Não | Sim | Sim |
| Precisa de um servidor | Não | Não — um ficheiro | Sim |
| Como se obtém | O default | `make:resource --sqlite` | `create-basalt --prisma` |
| Migrações | — | Uma lista de passos SQL, só se acrescenta | `prisma migrate` |
| Várias instâncias da app | — | Não (uma máquina) | Sim |
| Indicado para | Protótipos, testes | Apps pequenas num servidor | SaaS em produção |

Começa em memória e muda de ideias depois: o resto da app nunca sabe com qual
está a falar.

[[toc]]

## Um repositório por recurso

O `basalt make:resource` gera uma vertical em `src/modules/<nome>/`. A peça que
toca nos dados é o **repositório**: uma interface, mais uma classe que a
implementa.

```ts
// src/modules/product/product.repository.ts (gerado)
export interface ProductRepository {
  list(): Promise<Product[]>
  find(id: string): Promise<Product | null>
  create(input: CreateProductInput): Promise<Product>
  update(id: string, input: UpdateProductInput): Promise<Product | null>
  delete(id: string): Promise<boolean>
}
```

O serviço e as rotas só conhecem a interface. O plugin decide que classe lhe
responde:

```ts
// src/modules/product/product.plugin.ts (gerado)
container.singleton(PRODUCT_REPOSITORY, () => new InMemoryProductRepository())
```

Mudar de base de dados é mudar essa linha, e a classe por trás dela.

## Em memória — o default

```bash
pnpm create basalt my-shop
cd my-shop
pnpm basalt make:resource Product
pnpm dev
```

O `InMemoryProductRepository` guarda as linhas num `Map`, uma partição por
tenant. Tudo funciona — rotas, validação, isolamento entre tenants, o teste
gerado — e tudo desaparece quando o processo para. É esse o objetivo: um
protótipo ou uma suite de testes sem nada para instalar.

## SQLite — um ficheiro, sem servidor

O SQLite guarda a base de dados inteira num ficheiro, através do `node:sqlite`
que vem com o Node: sem ORM, sem serviço para correr, sem dependências extra.
Uma flag no gerador trata disso; os quatro passos a seguir mostram o que ela
escreve, e são o caminho para mudar um recurso que já tens.

::: tip Versão do Node
O `node:sqlite` é estável no **Node 24**. No Node 22.5+ corre com
`--experimental-sqlite`.
:::

### O caminho curto: `--sqlite`

```bash
pnpm basalt make:resource Product --sqlite
```

O gerador (`@basaltkit/generator` 1.7+) escreve o `SqliteProductRepository` no
`product.repository.ts`, em vez da classe em memória, e o plugin abre-o com
`database()`. Da primeira vez faz também os passos 1 e 2 abaixo: cria o
`src/db.ts`, declara o `DATABASE_PATH` no `src/env.ts` e acrescenta `data/` ao
`.gitignore`. Cada recurso seguinte acrescenta o seu `CREATE TABLE` aos
`MIGRATIONS` do `src/db.ts`, e já sem flag: quando o `src/db.ts` é esse módulo,
o `--sqlite` passa a ser o default (`--no-sqlite` para um em memória).

```txt
Created src/db.ts: one SQLite file (DATABASE_PATH, default ./data/app.db; in memory under NODE_ENV=test), migrated on first use. Its first step creates the products table.
  DATABASE_PATH is declared in src/env.ts.
```

Um recurso de tenant recebe uma coluna `tenant_id` indexada e o filtro
`requireTenantId()` do [passo 3](#_3-o-repositorio); com `--no-tenant` a tabela é
partilhada por toda a app. Aqui só existe o isolamento por coluna: um ficheiro
não tem um schema ou uma base de dados por tenant, por isso
`--tenant=schema|database` pede `--prisma`. Depois faz o
[passo 4](#_4-as-tabelas-da-framework-no-mesmo-ficheiro), para os teus
utilizadores também sobreviverem a um reinício.

### 1. Onde fica o ficheiro

Acrescenta o caminho ao `src/env.ts`:

```ts
// src/env.ts — dentro de defineEnv({ … })
DATABASE_PATH: z.string().default('./data/app.db'),
```

É lido como `MY_SHOP_DATABASE_PATH` (o
[prefixo](/pt/guide/getting-started#_2-instalar-e-configurar) do scaffold).
Acrescenta `data/` ao `.gitignore`.

### 2. Abrir a base de dados e criar as tabelas

```ts
// src/db.ts
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { env } from './env.js'

/**
 * The app's tables, in order. Each step runs once and is recorded in
 * `app_migrations`; to change the schema, append a step — never edit one that
 * has already run somewhere.
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE products (
     id         TEXT PRIMARY KEY,
     tenant_id  TEXT NOT NULL,
     name       TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX products_tenant ON products (tenant_id);`,
]

let shared: DatabaseSync | undefined

/** The app's database, opened and migrated on first use. Tests get a fresh in-memory one. */
export function database(): DatabaseSync {
  shared ??= openDatabase(env.NODE_ENV === 'test' ? ':memory:' : env.DATABASE_PATH)
  return shared
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  db.exec('CREATE TABLE IF NOT EXISTS app_migrations (step INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)')
  const done = new Set(
    (db.prepare('SELECT step FROM app_migrations').all() as { step: number }[]).map((row) => row.step),
  )
  MIGRATIONS.forEach((sql, step) => {
    if (done.has(step)) return
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO app_migrations (step, applied_at) VALUES (?, ?)').run(step, new Date().toISOString())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
  return db
}
```

Um passo que falha é desfeito por inteiro, por isso o ficheiro nunca fica
meio migrado.

### 3. O repositório

O `--sqlite` escreve esta classe no `product.repository.ts`. À mão, para um
recurso que hoje está em memória, escreve-a como uma segunda implementação da
interface gerada, ao lado dela:

```ts
// src/modules/product/product.sqlite.ts
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { requireTenantId } from '@basaltkit/tenancy'
import type { ProductRepository } from './product.repository.js'
import type { CreateProductInput, Product, UpdateProductInput } from './product.schema.js'

interface Row {
  id: string
  name: string
  created_at: string
  updated_at: string
}

const toProduct = (r: Row): Product => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at })

/** SQLite-backed, tenant-owned: every statement carries the context tenant. */
export class SqliteProductRepository implements ProductRepository {
  constructor(private readonly db: DatabaseSync) {}

  async list(): Promise<Product[]> {
    const rows = this.db.prepare('SELECT * FROM products WHERE tenant_id = ? ORDER BY created_at').all(requireTenantId())
    return (rows as unknown as Row[]).map(toProduct)
  }

  async find(id: string): Promise<Product | null> {
    const row = this.db.prepare('SELECT * FROM products WHERE id = ? AND tenant_id = ?').get(id, requireTenantId())
    return row ? toProduct(row as unknown as Row) : null
  }

  async create(input: CreateProductInput): Promise<Product> {
    const now = new Date().toISOString()
    const product: Product = { id: randomUUID(), name: input.name, createdAt: now, updatedAt: now }
    this.db
      .prepare('INSERT INTO products (id, tenant_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(product.id, requireTenantId(), product.name, now, now)
    return product
  }

  async update(id: string, input: UpdateProductInput): Promise<Product | null> {
    const existing = await this.find(id)
    if (!existing) return null
    const updated: Product = { ...existing, ...input, updatedAt: new Date().toISOString() }
    this.db
      .prepare('UPDATE products SET name = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
      .run(updated.name, updated.updatedAt, id, requireTenantId())
    return updated
  }

  async delete(id: string): Promise<boolean> {
    const { changes } = this.db.prepare('DELETE FROM products WHERE id = ? AND tenant_id = ?').run(id, requireTenantId())
    return Number(changes) > 0
  }
}
```

Duas regras mantêm-no seguro:

- **Sempre placeholders `?`**, nunca valores colados na string do SQL.
- **Cada instrução filtra por `requireTenantId()`** — a mesma regra
  fail-closed dos repositórios gerados: sem tenant resolvido, não há query (400
  `TENANT_REQUIRED`), e uma linha de outro tenant é simplesmente "não
  encontrada". Numa app criada com `--no-tenancy`, tira a coluna `tenant_id` e
  o filtro.

Depois aponta o plugin para ele:

```ts
// src/modules/product/product.plugin.ts
import { database } from '../../db.js'
import { SqliteProductRepository } from './product.sqlite.js'

container.singleton(PRODUCT_REPOSITORY, () => new SqliteProductRepository(database()))
```

### 4. As tabelas da framework no mesmo ficheiro

Os teus produtos já sobrevivem a um reinício, mas os utilizadores a quem
pertencem não: as stores de auth, equipas e tenancy do scaffold continuam em
memória. Os pacotes SQLite delas aceitam o mesmo handle, por isso fica tudo num
ficheiro:

```bash
pnpm add @basaltkit/auth-sqlite @basaltkit/teams-sqlite @basaltkit/tenancy-sqlite
```

```ts
// src/app.ts
import { sqliteAuthStores } from '@basaltkit/auth-sqlite'
import { sqliteTeamsStores } from '@basaltkit/teams-sqlite'
import { sqliteTenantSource } from '@basaltkit/tenancy-sqlite'
import { database } from './db.js'

// One SQLite file for everything: the framework's tables and the app's own.
const db = database()
const tenants = sqliteTenantSource(db)
const authStores = sqliteAuthStores(db)
const teamStores = sqliteTeamsStores(db)
// The tenant the header and subdomain resolvers expect in development.
if (env.NODE_ENV !== 'production') await tenants.save({ id: 'demo', name: 'Demo Tenant' })

// …e depois, no buildApp():
tenancyPlugin({ source: tenants, resolvers: [headerResolver(), subdomainResolver({ base: 'localhost' })] }),
authPlugin({
  secret: env.APP_SECRET,
  users: authStores.users,
  sessions: authStores.sessions,
  refreshTokens: authStores.refreshTokens,
  tokens: authStores.tokens,
  mfa: authStores.mfa,
}),
teamsPlugin({ memberships: teamStores.memberships, invitations: teamStores.invitations }),
```

Cada pacote cria as suas tabelas (de forma idempotente) e nenhum toca em
`app_migrations`, por isso nunca colidem com as tuas.

### Confirmar

```bash
pnpm dev
curl -X POST localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'
curl -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'   # → accessToken
curl -X POST localhost:3000/products -H 'content-type: application/json' \
  -H 'authorization: Bearer <accessToken>' -H 'x-tenant-id: demo' -d '{"name":"Coffee"}'
```

Para a app, arranca-a de novo, volta a fazer login: o `GET /products` com o
mesmo `x-tenant-id` continua a mostrar o café. O `pnpm test` continua a correr
sem ficheiro — o `database()` abre `:memory:` com `NODE_ENV=test`.

::: warning SQLite em produção
Um ficheiro quer dizer uma máquina: duas instâncias da app não o podem
partilhar. Faz backup com `sqlite3 data/app.db ".backup data/backup.db"` (seguro
com a app a correr), não copiando o ficheiro. Quando um servidor deixar de
chegar, passa para PostgreSQL — a interface do repositório fica, só a classe
muda.
:::

## PostgreSQL com Prisma

### Um projeto novo

```bash
pnpm create basalt my-shop --prisma
cd my-shop
```

Sem `--prisma` não há base de dados nenhuma. Com ele, o scaffold escreve o
`prisma/schema.prisma` (os modelos da framework mais um `Project` de exemplo), o
`src/db.ts` com os clientes, as stores Prisma no `src/app.ts`, um
`prisma/seed.ts` e os scripts `db:*` — cada ficheiro está listado em
[PostgreSQL com `--prisma`](/pt/guide/installation#postgresql-com-prisma).

Arranca um PostgreSQL. O `.env` gerado já aponta para este:

```bash
docker run -d --name my-shop-pg -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=my_shop \
  postgres:17
```

Qualquer outro servidor também serve: edita o `MY_SHOP_DATABASE_URL` no `.env`.
Em desenvolvimento o utilizador precisa de `CREATEDB` (o `prisma migrate dev`
cria uma base de dados sombra temporária).

```bash
pnpm db:migrate --name init   # cria as tabelas
pnpm db:seed                  # o tenant demo
pnpm dev
```

### Acrescentar uma tabela

```bash
pnpm basalt make:resource Product
```

Numa app com `prisma/schema.prisma` o repositório é Prisma sem flag nenhuma, e o
modelo vai direto para o schema:

```
Generated 6 file(s):
  src/modules/product/product.plugin.ts
  src/modules/product/product.repository.ts
  …
Added model Product to prisma/schema.prisma. Create the table: pnpm db:migrate --name add_product && pnpm db:generate
```

```prisma
// prisma/schema.prisma — acrescentado
model Product {
  id        String   @id @default(cuid())
  tenantId  String
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId])
}
```

Corre a linha que ele mostrou. O `db:migrate` escreve a migração em
`prisma/migrations/` (faz commit dela) e aplica-a; o `db:generate` atualiza os
tipos do cliente — o `migrate dev` do Prisma 7 já não o faz. O
`PrismaProductRepository` lê através do `db<PrismaClient>()`, o cliente do pedido
com escopo de tenant, e filtra ele próprio cada query por `tenantId`.

O `--no-prisma` continua a gerar o repositório em memória.

### Correr os testes contra ela

O `tests/product.test.ts` gerado arranca o recurso com o `prismaPlugin` e o
cliente da app de `src/db.ts`. O `pnpm test` não carrega o `.env`, por isso sem o
URL no ambiente a suite **é saltada**; com ele, corre contra a base de dados
real — cada corrida com tenants novos, para que linhas de corridas anteriores
não atrapalhem:

```bash
MY_SHOP_DATABASE_URL=postgres://postgres:postgres@localhost:5432/my_shop pnpm test
```

### Em produção

O `pnpm db:deploy` (`prisma migrate deploy`) aplica as migrações commitadas —
nunca `prisma db push`: a app arranca com `assertMigrated: true` e recusa uma
base de dados sem histórico de migrações. Várias instâncias, backups (vê
[Backups PostgreSQL](/pt/guide/backup)), schema ou base de dados por tenant (vê
[Base de dados por tenant](/pt/guide/database-per-tenant)) começam todos aqui. O
MySQL funciona pelo mesmo caminho do Prisma — vê [MySQL](/pt/guide/persistence#mysql).

## Acrescentar um campo

Uma coluna vive em três sítios; muda os três juntos. Para um `price` no
`Product`:

1. **A forma da API** — `src/modules/product/product.schema.ts`:

   ```ts
   export const ProductSchema = z.object({ /* … */ price: z.number().int() })
   export const CreateProductSchema = z.object({ name: z.string().min(1), price: z.number().int().min(0) })
   ```

2. **A tabela**
   - Prisma: `price Int @default(0)` no modelo, depois
     `pnpm db:migrate --name product_price && pnpm db:generate`.
   - SQLite: acrescenta um passo a `MIGRATIONS` —
     `ALTER TABLE products ADD COLUMN price INTEGER NOT NULL DEFAULT 0`.

3. **O repositório** — mapeia a coluna: o mapper `toProduct` (e, em SQLite, as
   instruções `INSERT`/`UPDATE`). Em memória, nada a fazer.

O `pnpm typecheck` aponta para aquele dos três que te escapou.

## Resolução de problemas

| Sintoma | Causa | Solução |
| --- | --- | --- |
| `TS2305: Module '"@prisma/client"' has no exported member 'PrismaClient'` num repositório gerado | Gerado pelo `@basaltkit/generator` < 1.7, que não conhecia o cliente do scaffold (`#db/client.js`) | `pnpm basalt update`, ou muda o import para `import type { PrismaClient } from '#db/client.js'` |
| O teste gerado responde 500, `DbUnavailableError: No database client in the current context` | Teste gerado antes da 1.7: arranca sem `prismaPlugin` | Gera-o de novo (`pnpm basalt make:test Product --prisma --force`) |
| `400 TENANT_REQUIRED` | O pedido não indicou tenant | Envia `x-tenant-id` (ou usa o subdomínio do tenant); os dados de uma tabela de tenant pertencem sempre a um |
| O arranque falha: _the database is not migrated_ | Base de dados nova, ou um `DATABASE_URL` a apontar para outro sítio | `pnpm db:migrate` (desenvolvimento) / `pnpm db:deploy` (produção); confirma que URL ganhou — [a armadilha da precedência](/pt/guide/installation#o-env-file-nunca-sobrepoe-variaveis-exportadas) |
| As linhas sobrevivem a um reinício, os utilizadores não | Só o teu repositório é durável; as stores de auth/equipas/tenancy continuam em memória | [Passo 4](#_4-as-tabelas-da-framework-no-mesmo-ficheiro) (SQLite) — o `--prisma` já as liga |
| `database is locked` (SQLite) | Dois processos a escrever no mesmo ficheiro | Uma instância da app por ficheiro; o `busy_timeout` cobre sobreposições curtas (um reload do `pnpm dev`) |
