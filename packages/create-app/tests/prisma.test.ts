import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject, runWizard, scriptedPrompter } from '../src/index.js'
import { parseArgs, USAGE } from '../src/args.js'
import { thirdPartyVersionOf, versionOf } from '../src/templates.js'

/**
 * `--prisma`: a scaffold with a real PostgreSQL database behind it (BK-018,
 * second half). Without the flag the scaffold must stay byte-for-byte what it
 * was — memory sources, no database, no Prisma dependency.
 */

const here = dirname(fileURLToPath(import.meta.url))
const packagesDir = join(here, '..', '..')

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'create-basalt-prisma-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const read = (dir: string, file: string) => readFile(join(dir, file), 'utf8')

describe('--prisma is off by default (the scaffold stays database-free)', () => {
  it('writes no Prisma file, no Prisma dependency and keeps the memory sources', async () => {
    const result = await createProject({ name: 'my-saas', dir: join(root, 'plain'), billing: true })

    expect(result.options.prisma).toBe(false)
    for (const path of ['prisma/schema.prisma', 'prisma.config.ts', 'prisma/seed.ts', 'src/db.ts']) {
      expect(result.files).not.toContain(path)
    }

    const pkg = JSON.parse(await read(result.dir, 'package.json'))
    expect(pkg.dependencies).not.toHaveProperty('@prisma/client')
    expect(pkg.dependencies).not.toHaveProperty('@basaltkit/prisma')
    expect(pkg.dependencies).not.toHaveProperty('@basaltkit/auth-prisma')
    expect(pkg.devDependencies).not.toHaveProperty('prisma')
    expect(pkg.scripts).not.toHaveProperty('db:migrate')
    expect(pkg.scripts).not.toHaveProperty('postinstall')

    const app = await read(result.dir, 'src/app.ts')
    expect(app).toContain('MemoryTenantSource')
    expect(app).toContain('MemoryUserSource')
    expect(app).not.toContain('prismaPlugin')

    // DATABASE_URL stays a documented "when you add one", never a required var.
    expect(await read(result.dir, 'src/env.ts')).not.toContain('DATABASE_URL: z.string()')
    expect(await read(result.dir, '.env.example')).toMatch(/^# MY_SAAS_DATABASE_URL=/m)
  })

  it('keeps @basaltkit/prisma a --cli-only dependency without the flag', async () => {
    const result = await createProject({ name: 'clionly', dir: join(root, 'clionly'), cli: true })
    const pkg = JSON.parse(await read(result.dir, 'package.json'))
    expect(pkg.dependencies).toHaveProperty('@basaltkit/prisma')
    expect(pkg.dependencies).not.toHaveProperty('@prisma/client')
    expect(result.files).not.toContain('prisma/schema.prisma')
  })
})

describe('--prisma generates a PostgreSQL-backed app', () => {
  const scaffold = (name: string, input: Record<string, unknown> = {}) =>
    createProject({ name, dir: join(root, name), prisma: true, ...input })

  it('writes the schema, the Prisma config, the client and the seed', async () => {
    const result = await scaffold('my-saas')
    for (const path of ['prisma/schema.prisma', 'prisma.config.ts', 'prisma/seed.ts', 'src/db.ts']) {
      expect(result.files).toContain(path)
    }

    const schema = await read(result.dir, 'prisma/schema.prisma')
    // Prisma 7: the URL lives in prisma.config.ts, and the client needs an output.
    expect(schema).toContain('provider = "postgresql"')
    expect(schema).toContain('output   = "../src/generated/prisma"')
    expect(schema).not.toContain('env("DATABASE_URL")')
    // The domain models the enabled features need.
    for (const model of ['model Tenant ', 'model AuthUser ', 'model TeamMembership ']) {
      expect(schema).toContain(model)
    }
    // …and an app-owned model showing the tenant column the extension scopes by.
    expect(schema).toContain('model Project ')
    expect(schema).toMatch(/model Project \{[^}]*tenantId +String/)

    const config = await read(result.dir, 'prisma.config.ts')
    expect(config).toContain("import { defineConfig } from 'prisma/config'")
    // Same precedence as src/env.ts: prefixed first, bare name only as fallback.
    expect(config).toContain("process.env['MY_SAAS_DATABASE_URL'] ?? process.env['DATABASE_URL']")
    expect(config).toContain("seed: 'tsx prisma/seed.ts'")
  })

  it('creates the client with the tenancy extension in src/db.ts', async () => {
    const dbTs = await read((await scaffold('dbts')).dir, 'src/db.ts')
    expect(dbTs).toContain("import { PrismaPg } from '@prisma/adapter-pg'")
    expect(dbTs).toContain("from './generated/prisma/client.js'")
    expect(dbTs).toContain('new PrismaPg({ connectionString: env.DATABASE_URL })')
    expect(dbTs).toContain("import { tenancyExtension } from '@basaltkit/prisma'")
    expect(dbTs).toContain('export const db = prisma.$extends(tenancyExtension())')

    // Without tenancy there is no tenant column to scope by.
    const noTenancy = await read((await scaffold('dbflat', { tenancy: false })).dir, 'src/db.ts')
    expect(noTenancy).not.toContain('tenancyExtension')
    expect(noTenancy).toContain('export const db = prisma')
  })

  it('wires prismaPlugin({ assertMigrated: true }) and the Prisma-backed stores', async () => {
    const app = await read((await scaffold('wired', { billing: true })).dir, 'src/app.ts')

    expect(app).toContain("import { prismaPlugin } from '@basaltkit/prisma'")
    expect(app).toMatch(/prismaPlugin\(\{[\s\S]*client: db,[\s\S]*assertMigrated: true,[\s\S]*\}\)/)
    // The comment next to it must say why db push is not an option here.
    expect(app).toMatch(/db push/)

    // Every memory store is gone.
    expect(app).not.toContain('MemoryTenantSource')
    expect(app).not.toContain('MemoryUserSource')

    expect(app).toContain("import { prismaTenantSource } from '@basaltkit/tenancy-prisma'")
    expect(app).toContain('source: tenants')
    expect(app).toContain("import { prismaAuthStores } from '@basaltkit/auth-prisma'")
    expect(app).toContain('users: authStores.users')
    expect(app).toContain('mfa: authStores.mfa')
    expect(app).toContain("import { prismaTeamsStores } from '@basaltkit/teams-prisma'")
    expect(app).toContain('memberships: teamStores.memberships')
    expect(app).toContain("import { prismaSubscriptionsStores } from '@basaltkit/subscriptions-prisma'")
    expect(app).toContain('store: subscriptionStores.store')
  })

  it('declares the Prisma dependencies and the database scripts', async () => {
    const result = await scaffold('deps', { billing: true, cli: true })
    const pkg = JSON.parse(await read(result.dir, 'package.json'))

    expect(pkg.dependencies['@basaltkit/prisma']).toBe(versionOf('@basaltkit/prisma'))
    expect(pkg.dependencies['@basaltkit/tenancy-prisma']).toBe(versionOf('@basaltkit/tenancy-prisma'))
    expect(pkg.dependencies['@basaltkit/auth-prisma']).toBe(versionOf('@basaltkit/auth-prisma'))
    expect(pkg.dependencies['@basaltkit/teams-prisma']).toBe(versionOf('@basaltkit/teams-prisma'))
    expect(pkg.dependencies['@basaltkit/subscriptions-prisma']).toBe(
      versionOf('@basaltkit/subscriptions-prisma'),
    )
    expect(pkg.dependencies['@prisma/client']).toBe(thirdPartyVersionOf('@prisma/client'))
    expect(pkg.dependencies['@prisma/adapter-pg']).toBe(thirdPartyVersionOf('@prisma/adapter-pg'))
    expect(pkg.dependencies['pg']).toBe(thirdPartyVersionOf('pg'))
    // The Prisma CLI is a dev tool; the app never runs migrations by itself.
    expect(pkg.devDependencies['prisma']).toBe(thirdPartyVersionOf('prisma'))
    expect(pkg.devDependencies).toHaveProperty('@types/pg')

    // `prisma generate` after install, so `pnpm typecheck` has the client types.
    expect(pkg.scripts.postinstall).toBe('prisma generate')
    expect(pkg.scripts['db:migrate']).toBe('prisma migrate dev')
    expect(pkg.scripts['db:deploy']).toBe('prisma migrate deploy')
    expect(pkg.scripts['db:generate']).toBe('prisma generate')
    expect(pkg.scripts['db:seed']).toBe('tsx prisma/seed.ts')
    // `db push` leaves no _prisma_migrations, which assertMigrated requires.
    expect(pkg.scripts).not.toHaveProperty('db:push')

    // Only the packages whose features are on.
    const lean = await scaffold('leandeps', { auth: false, tenancy: false })
    const leanPkg = JSON.parse(await read(lean.dir, 'package.json'))
    expect(leanPkg.dependencies).not.toHaveProperty('@basaltkit/auth-prisma')
    expect(leanPkg.dependencies).not.toHaveProperty('@basaltkit/tenancy-prisma')
    expect(leanPkg.dependencies).not.toHaveProperty('@basaltkit/teams-prisma')
    expect(leanPkg.dependencies).toHaveProperty('@basaltkit/prisma')
  })

  it('requires the app-prefixed DATABASE_URL', async () => {
    const result = await scaffold('my-saas')

    const env = await read(result.dir, 'src/env.ts')
    expect(env).toContain('DATABASE_URL: z.string().min(1)')
    expect(env).toContain("prefix: 'MY_SAAS'")

    const example = await read(result.dir, '.env.example')
    // A live (uncommented) line: the app does not boot without it.
    expect(example).toMatch(/^MY_SAAS_DATABASE_URL=postgres:\/\//m)
    for (const line of example.split('\n').filter((l) => l && !l.startsWith('#'))) {
      expect(line).toMatch(/^[A-Z][A-Z0-9_]*=/)
    }
  })

  it('documents migrate dev / migrate deploy and warns against db push', async () => {
    const readme = await read((await scaffold('docs')).dir, 'README.md')
    expect(readme).toContain('## Database')
    expect(readme).toContain('pnpm db:migrate')
    expect(readme).toContain('prisma migrate deploy')
    expect(readme).toContain('_prisma_migrations')
    expect(readme).toContain('assertMigrated')
    // `db push` may only appear as the warning it is.
    expect(readme).toMatch(/never use .*db push|db push.*never/i)
  })

  it('gates the generated smoke test on a database being configured', async () => {
    const test = await read((await scaffold('my-saas')).dir, 'tests/app.test.ts')
    expect(test).toContain('skipIf')
    expect(test).toContain('MY_SAAS_DATABASE_URL')

    const plain = await createProject({ name: 'plain', dir: join(root, 'plaintest') })
    expect(await read(plain.dir, 'tests/app.test.ts')).not.toContain('skipIf')
  })

  it('keeps the generated client out of git', async () => {
    const ignore = await read((await scaffold('ignored')).dir, '.gitignore')
    expect(ignore.split('\n')).toContain('src/generated/')
  })
})

describe('the emitted models stay in sync with the @basaltkit/*-prisma reference schemas', () => {
  /** Top-level `model X { … }` blocks of a schema, by model name. */
  const models = (schema: string): Map<string, string> => {
    const found = new Map<string, string>()
    const header = /^model\s+(\w+)\s*\{/gm
    let match: RegExpExecArray | null
    while ((match = header.exec(schema)) !== null) {
      const start = match.index
      const end = schema.indexOf('\n}', start)
      if (end === -1) continue
      found.set(match[1] as string, schema.slice(start, end + 2))
      header.lastIndex = end + 2
    }
    return found
  }

  const reference = (domain: string): Map<string, string> =>
    models(readFileSync(join(packagesDir, `${domain}-prisma`, 'prisma', 'schema.prisma'), 'utf8'))

  it('copies each package model verbatim (a package schema change fails here)', async () => {
    const result = await createProject({
      name: 'sync',
      dir: join(root, 'sync'),
      prisma: true,
      billing: true,
    })
    const emitted = models(await read(result.dir, 'prisma/schema.prisma'))

    const expected = [
      ...reference('tenancy'),
      ...reference('auth'),
      ...reference('teams'),
      // The subscription stores only; Payment/RecurringSubscription belong to
      // the payment drivers, which the scaffold does not wire.
      ...[...reference('subscriptions')].filter(([name]) =>
        ['Subscription', 'UsageCounter', 'WebhookEvent'].includes(name),
      ),
    ]
    expect(expected.length).toBeGreaterThan(10)
    for (const [name, block] of expected) {
      expect(emitted.get(name), `${name} is emitted`).toBeDefined()
      expect(emitted.get(name), `${name} matches the reference schema`).toBe(block)
    }
  })
})

describe('--prisma reaches the flags, the wizard and the usage text', () => {
  it('parses --prisma (off by default)', () => {
    expect(parseArgs([]).prisma).toBe(false)
    expect(parseArgs(['--prisma']).prisma).toBe(true)
    expect(USAGE).toContain('--prisma')
  })

  it('is offered as a feature and included in the database-backed presets', async () => {
    const custom = await runWizard(
      scriptedPrompter({
        text: ['picked'],
        select: ['custom', 'pnpm'],
        multiselect: [['auth', 'prisma']],
        confirm: [false, false, true],
      }),
    )
    expect(custom.prisma).toBe(true)

    const saas = await runWizard(
      scriptedPrompter({
        text: ['starter'],
        select: ['saas', 'pnpm'],
        confirm: [false, false, true],
      }),
    )
    expect(saas.prisma).toBe(true)

    const minimal = await runWizard(
      scriptedPrompter({
        text: ['bare'],
        select: ['minimal', 'pnpm'],
        confirm: [false, false, true],
      }),
    )
    expect(minimal.prisma).toBe(false)
  })
})
