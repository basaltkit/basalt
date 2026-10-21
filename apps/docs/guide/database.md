# Database

Your app has two kinds of data. The framework's — users, sessions, tenants,
team memberships — lives behind store contracts, covered in
[Persistence & durable stores](/guide/persistence). **Your own** — products,
orders, invoices, whatever the app is about — lives in tables you design. This
page is about the second kind, and shows both together, because a real project
needs both in the same database.

There are three ways to keep it:

| | In memory | SQLite | PostgreSQL (Prisma) |
| --- | --- | --- | --- |
| Survives a restart | No | Yes | Yes |
| Needs a server | No | No — one file | Yes |
| How you get it | The default | `make:resource --sqlite` | `create-basalt --prisma` |
| Migrations | — | An append-only list of SQL steps | `prisma migrate` |
| Several app instances | — | No (one machine) | Yes |
| Good for | Prototypes, tests | Small apps on one server | Production SaaS |

Start in memory, and change your mind later: the rest of the app never knows
which one it is talking to.

[[toc]]

## One repository per resource

`basalt make:resource` generates a vertical in `src/modules/<name>/`. The piece
that touches the data is the **repository**: an interface, plus one class that
implements it.

```ts
// src/modules/product/product.repository.ts (generated)
export interface ProductRepository {
  list(): Promise<Product[]>
  find(id: string): Promise<Product | null>
  create(input: CreateProductInput): Promise<Product>
  update(id: string, input: UpdateProductInput): Promise<Product | null>
  delete(id: string): Promise<boolean>
}
```

The service and the routes only know the interface. The plugin decides which
class answers it:

```ts
// src/modules/product/product.plugin.ts (generated)
container.singleton(PRODUCT_REPOSITORY, () => new InMemoryProductRepository())
```

Changing database is changing that one line, and the class behind it.

## In memory — the default

```bash
pnpm create basalt my-shop
cd my-shop
pnpm basalt make:resource Product
pnpm dev
```

`InMemoryProductRepository` keeps the rows in a `Map`, one partition per tenant.
Everything works — routes, validation, tenant isolation, the generated test —
and everything is gone when the process stops. That is the point: a prototype
or a test suite with nothing to install.

## SQLite — one file, no server

SQLite keeps the whole database in one file, through Node's built-in
`node:sqlite`: no ORM, no service to run, no extra dependency. One flag on the
generator gets you there; the four steps after it show what it writes, and are
how you move a resource you already have.

::: tip Node version
`node:sqlite` is stable on **Node 24**. On Node 22.5+ run with
`--experimental-sqlite`.
:::

### The short way: `--sqlite`

```bash
pnpm basalt make:resource Product --sqlite
```

The generator (`@basaltkit/generator` 1.7+) writes `SqliteProductRepository` in
`product.repository.ts` instead of the in-memory class, and the plugin opens it
with `database()`. The first time, it also does steps 1 and 2 below for you:
it creates `src/db.ts`, declares `DATABASE_PATH` in `src/env.ts` and adds
`data/` to `.gitignore`. Every later resource appends its `CREATE TABLE` to
the `MIGRATIONS` in `src/db.ts`, and needs no flag: once `src/db.ts` is that
module, `--sqlite` is the default (`--no-sqlite` for an in-memory one).

```txt
Created src/db.ts: one SQLite file (DATABASE_PATH, default ./data/app.db; in memory under NODE_ENV=test), migrated on first use. Its first step creates the products table.
  DATABASE_PATH is declared in src/env.ts.
```

A tenant-owned resource gets an indexed `tenant_id` column and the
`requireTenantId()` filter of [step 3](#_3-the-repository); with `--no-tenant`
the table is shared by the whole app. Only the column isolation exists here:
one file has no schema or database per tenant, so `--tenant=schema|database`
asks for `--prisma`. Then do [step 4](#_4-the-framework-s-tables-in-the-same-file),
so your users survive a restart too.

### 1. Where the file lives

Add the path to `src/env.ts`:

```ts
// src/env.ts — inside defineEnv({ … })
DATABASE_PATH: z.string().default('./data/app.db'),
```

It is read as `MY_SHOP_DATABASE_PATH` (the scaffold's
[prefix](/guide/getting-started#_2-install-and-configure)). Add `data/` to
`.gitignore`.

### 2. Open the database and create the tables

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

A step that fails rolls back whole, so the file is never left half-migrated.

### 3. The repository

`--sqlite` writes this class into `product.repository.ts`. By hand, for a
resource that is in memory today, write it as a second implementation of the
generated interface, next to it:

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

Two rules keep it safe:

- **Always `?` placeholders**, never values pasted into the SQL string.
- **Every statement filters on `requireTenantId()`** — the same fail-closed
  rule as the generated repositories: no tenant resolved, no query (400
  `TENANT_REQUIRED`), and a row of another tenant is simply "not found". In an
  app created with `--no-tenancy`, drop the `tenant_id` column and the filter.

Then point the plugin at it:

```ts
// src/modules/product/product.plugin.ts
import { database } from '../../db.js'
import { SqliteProductRepository } from './product.sqlite.js'

container.singleton(PRODUCT_REPOSITORY, () => new SqliteProductRepository(database()))
```

### 4. The framework's tables in the same file

Your products now survive a restart, but the users who own them do not: the
scaffold's auth, teams and tenancy stores are still in memory. Their SQLite
packages take the same handle, so everything lives in one file:

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

// …then, in buildApp():
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

Each package creates its own tables (idempotently) and none of them touches
`app_migrations`, so they never collide with yours.

### Check it

```bash
pnpm dev
curl -X POST localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'
curl -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"secretpassword1"}'   # → accessToken
curl -X POST localhost:3000/products -H 'content-type: application/json' \
  -H 'authorization: Bearer <accessToken>' -H 'x-tenant-id: demo' -d '{"name":"Coffee"}'
```

Stop the app, start it again, log in again: `GET /products` with the same
`x-tenant-id` still lists the coffee. `pnpm test` keeps running without a file —
`database()` opens `:memory:` under `NODE_ENV=test`.

::: warning SQLite in production
One file means one machine: two app instances cannot share it. Back it up with
`sqlite3 data/app.db ".backup data/backup.db"` (safe while the app runs), not by
copying the file. When you outgrow one server, move to PostgreSQL — the
repository interface stays, only the class changes.
:::

## PostgreSQL with Prisma

### A new project

```bash
pnpm create basalt my-shop --prisma
cd my-shop
```

Without `--prisma` there is no database at all. With it, the scaffold writes
`prisma/schema.prisma` (the framework's models plus a sample `Project`),
`src/db.ts` with the clients, the Prisma-backed stores in `src/app.ts`, a
`prisma/seed.ts`, and the `db:*` scripts — every file is listed in
[PostgreSQL with `--prisma`](/guide/installation#postgresql-with-prisma).

Start a PostgreSQL. The generated `.env` already points at this one:

```bash
docker run -d --name my-shop-pg -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=my_shop \
  postgres:17
```

Any other server works too: edit `MY_SHOP_DATABASE_URL` in `.env`. The user needs
`CREATEDB` in development (`prisma migrate dev` creates a temporary shadow
database).

```bash
pnpm db:migrate --name init   # creates the tables
pnpm db:seed                  # the demo tenant
pnpm dev
```

### Add a table

```bash
pnpm basalt make:resource Product
```

In an app with `prisma/schema.prisma` the repository is Prisma-backed without
any flag, and the model goes straight into the schema:

```
Generated 6 file(s):
  src/modules/product/product.plugin.ts
  src/modules/product/product.repository.ts
  …
Added model Product to prisma/schema.prisma. Create the table: pnpm db:migrate --name add_product && pnpm db:generate
```

```prisma
// prisma/schema.prisma — appended
model Product {
  id        String   @id @default(cuid())
  tenantId  String
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId])
}
```

Run the line it printed. `db:migrate` writes the migration under
`prisma/migrations/` (commit it) and applies it; `db:generate` refreshes the
client types — Prisma 7's `migrate dev` no longer does it. `PrismaProductRepository`
reads through `db<PrismaClient>()`, the request's tenant-scoped client, and
filters every query on `tenantId` itself.

`--no-prisma` still generates the in-memory repository.

### Run the tests against it

The generated `tests/product.test.ts` boots the resource with `prismaPlugin` and
the app's client from `src/db.ts`. `pnpm test` does not load `.env`, so without
the URL in the environment the suite **skips**; with it, it runs against the
real database — each run under fresh tenants, so rows from earlier runs do not
get in the way:

```bash
MY_SHOP_DATABASE_URL=postgres://postgres:postgres@localhost:5432/my_shop pnpm test
```

### In production

`pnpm db:deploy` (`prisma migrate deploy`) applies the committed migrations —
never `prisma db push`: the app boots with `assertMigrated: true` and refuses a
database without migration history. Multiple instances, backups (see
[PostgreSQL backups](/guide/backup)), schema- or database-per-tenant (see
[Database per tenant](/guide/database-per-tenant)) all start here. MySQL works
through the same Prisma path — see [MySQL](/guide/persistence#mysql).

## Adding a field

A column lives in three places; change all three together. For a `price` on
`Product`:

1. **The API shape** — `src/modules/product/product.schema.ts`:

   ```ts
   export const ProductSchema = z.object({ /* … */ price: z.number().int() })
   export const CreateProductSchema = z.object({ name: z.string().min(1), price: z.number().int().min(0) })
   ```

2. **The table**
   - Prisma: `price Int @default(0)` in the model, then
     `pnpm db:migrate --name product_price && pnpm db:generate`.
   - SQLite: append a step to `MIGRATIONS` —
     `ALTER TABLE products ADD COLUMN price INTEGER NOT NULL DEFAULT 0`.

3. **The repository** — map the column: the `toProduct` mapper (and, for
   SQLite, the `INSERT`/`UPDATE` statements). In memory, nothing to do.

`pnpm typecheck` points at whichever of the three you missed.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `TS2305: Module '"@prisma/client"' has no exported member 'PrismaClient'` in a generated repository | Generated by `@basaltkit/generator` < 1.7, which did not know the scaffold's client (`#db/client.js`) | `pnpm basalt update`, or change the import to `import type { PrismaClient } from '#db/client.js'` |
| Generated test answers 500, `DbUnavailableError: No database client in the current context` | Test generated before 1.7: it boots without `prismaPlugin` | Regenerate it (`pnpm basalt make:test Product --prisma --force`) |
| `400 TENANT_REQUIRED` | The request named no tenant | Send `x-tenant-id` (or use the tenant's subdomain); data in a tenant-owned table always belongs to one |
| Boot fails: _the database is not migrated_ | New database, or a `DATABASE_URL` pointing elsewhere | `pnpm db:migrate` (development) / `pnpm db:deploy` (production); check which URL won — [the precedence pitfall](/guide/installation#env-file-never-overrides-exported-variables) |
| Rows survive a restart, users do not | Only your repository is durable; auth/teams/tenancy stores are still in memory | [Step 4](#_4-the-framework-s-tables-in-the-same-file) (SQLite) — `--prisma` wires them already |
| `database is locked` (SQLite) | Two processes writing one file | One app instance per file; `busy_timeout` covers short overlaps (a `pnpm dev` reload) |
