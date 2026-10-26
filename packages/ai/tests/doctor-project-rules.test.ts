import { describe, expect, it } from 'vitest'
import { detectProject, memoryReader, runDoctor, type Diagnostic } from '../src/index.js'

const pkg = (deps: Record<string, string> = {}) =>
  JSON.stringify({ dependencies: { '@basaltkit/fastify': '^3.0.0', '@basaltkit/prisma': '^4.0.0', ...deps } })

const appWith = (plugins: string) => `
  import { fastifyPlugin } from '@basaltkit/fastify'
  export const buildApp = () => createApp({ plugins: [
    prismaPlugin({ client }),
    ${plugins}
    fastifyPlugin({ routes: [], fastify: { logger: true } }),
  ] })
`

const schema = (models: string, provider = 'postgresql') =>
  `datasource db { provider = "${provider}" }\n${models}`

function diagnose(files: Record<string, string>, id: string): Diagnostic | undefined {
  return runDoctor(detectProject('/proj', memoryReader({ 'package.json': pkg(), 'src/app.ts': appWith(''), ...files })))
    .find((d) => d.id === id)
}

describe('schema-not-migrated', () => {
  const models = schema(`
    model User { id String @id }
    model Post { id String @id @@map("posts") }
    model Note { id String @id }
  `)

  it('names the models no migration creates', () => {
    const found = diagnose({
      'prisma/schema.prisma': models,
      'prisma/migrations/20260101000000_init/migration.sql': 'CREATE TABLE "User" ("id" TEXT NOT NULL);',
    }, 'schema-not-migrated')
    expect(found?.severity).toBe('error')
    expect(found?.detected).toBe('no migration in prisma/migrations creates: Post, Note')
  })

  it('reads the @@map table, schema-qualified names, IF NOT EXISTS and renames', () => {
    const found = diagnose({
      'prisma/schema.prisma': models,
      'prisma/migrations/1_init/migration.sql': 'CREATE TABLE "public"."User" (id text);\nCREATE TABLE IF NOT EXISTS `posts` (id text);',
      'prisma/migrations/2_rename/migration.sql': 'CREATE TABLE "Old" (id text);\nALTER TABLE "Old" RENAME TO "Note";',
    }, 'schema-not-migrated')
    expect(found).toBeUndefined()
  })

  it('stays quiet for a project without migrations (db push)', () => {
    expect(diagnose({ 'prisma/schema.prisma': models }, 'schema-not-migrated')).toBeUndefined()
  })
})

describe('framework-schema-drift', () => {
  const reference = schema(`
    model AuthSession {
      id         String @id
      userId     String
      lastSeenAt DateTime?
      @@map("auth_sessions")
    }
  `)

  it("lists the columns of the installed package's model the app lacks", () => {
    const found = diagnose({
      'package.json': pkg({ '@basaltkit/auth-prisma': '^5.0.0' }),
      'node_modules/@basaltkit/auth-prisma/prisma/schema.prisma': reference,
      'prisma/schema.prisma': schema('model AuthSession { id String @id\n userId String\n @@map("auth_sessions") }'),
    }, 'framework-schema-drift')
    expect(found?.detected).toBe('missing from schema.prisma (@basaltkit/auth-prisma): AuthSession.lastSeenAt')
    expect(found?.fix).toContain('prisma:sync')
  })

  it('compares against the MySQL reference on a MySQL datasource', () => {
    const found = diagnose({
      'package.json': pkg({ '@basaltkit/auth-prisma': '^5.0.0' }),
      'node_modules/@basaltkit/auth-prisma/prisma/schema.prisma': reference,
      'node_modules/@basaltkit/auth-prisma/prisma/schema.mysql.prisma': schema('model AuthSession { id String @id\n userId String }', 'mysql'),
      'prisma/schema.prisma': schema('model AuthSession { id String @id\n userId String }', 'mysql'),
    }, 'framework-schema-drift')
    expect(found).toBeUndefined()
  })

  it('ignores a package model the app does not use, and extra columns of its own', () => {
    const found = diagnose({
      'package.json': pkg({ '@basaltkit/auth-prisma': '^5.0.0' }),
      'node_modules/@basaltkit/auth-prisma/prisma/schema.prisma': reference + '\nmodel AuthPasskey { id String @id }',
      'prisma/schema.prisma': schema('model AuthSession { id String @id\n userId String\n lastSeenAt DateTime?\n note String }'),
    }, 'framework-schema-drift')
    expect(found).toBeUndefined()
  })
})

describe('plugin-default-memory-store', () => {
  const check = (plugins: string, files: Record<string, string> = {}) =>
    diagnose({ 'src/app.ts': appWith(plugins), ...files }, 'plugin-default-memory-store')

  it('flags a plugin called without its store', () => {
    const found = check('commentsPlugin(), notificationsPlugin({ channels: [] }),')
    expect(found?.detected).toBe('src/app.ts: commentsPlugin() without store, notificationsPlugin() without inApp')
    expect(found?.fix).toContain('pnpm add @basaltkit/comments-prisma')
  })

  it('accepts the option, a variable or a spread', () => {
    expect(check('commentsPlugin({ store: comments.store }), auditPlugin(auditOptions), filesPlugin({ ...files }),')).toBeUndefined()
    expect(check('teamsPlugin({ memberships }),')).toBeUndefined()
  })

  it('ignores a commented-out call and an app without a database', () => {
    expect(check('// commentsPlugin(),')).toBeUndefined()
    const noDb = runDoctor(detectProject('/proj', memoryReader({
      'package.json': JSON.stringify({ dependencies: { '@basaltkit/fastify': '^3.0.0', '@basaltkit/comments': '^4.0.0' } }),
      'src/app.ts': 'createApp({ plugins: [commentsPlugin(), fastifyPlugin({ fastify: { logger: true } })] })',
    }))).find((d) => d.id === 'plugin-default-memory-store')
    expect(noDb).toBeUndefined()
  })
})

describe('context-at-module-scope', () => {
  const check = (source: string) => diagnose({ 'src/modules/x.ts': source }, 'context-at-module-scope')

  it('flags a top-level declaration that reads the context', () => {
    const found = check([
      "import { ctx, tryCtx } from '@basaltkit/core'",
      "import { db } from '@basaltkit/prisma'",
      'const posts = await db<PrismaClient>().post.findMany()',
      'export const tenant = tryCtx()?.tenant',
    ].join('\n'))
    expect(found?.severity).toBe('error')
    expect(found?.detected).toContain('src/modules/x.ts:3, src/modules/x.ts:4')
  })

  it('follows an aliased import', () => {
    expect(check("import { ctx as context } from '@basaltkit/core'\nconst id = context().requestId")?.detected)
      .toContain('src/modules/x.ts:2')
  })

  it('leaves functions, handlers and names from elsewhere alone', () => {
    expect(check([
      "import { ctx, type Container } from '@basaltkit/core'",
      "import { db } from './my-db.js'",
      'const service = () => (ctx().container as Container).get(SERVICE)',
      'const client = db()',
      'export function list() {',
      '  const posts = ctx().db',
      '  return posts',
      '}',
      'export const routes = [route({ handler: async () => ({ id: ctx().requestId }) })]',
      '// const old = ctx()',
    ].join('\n'))).toBeUndefined()
  })
})

describe('detached-hook-bus', () => {
  it('flags new HookBus() in app code, not in a comment or a test', () => {
    const found = diagnose({
      'src/a.ts': "import { HookBus } from '@basaltkit/core'\n\nconst hooks = new HookBus()",
      'src/b.ts': '// const hooks = new HookBus()',
      'src/a.test.ts': 'const hooks = new HookBus()',
    }, 'detached-hook-bus')
    expect(found?.detected).toBe('new HookBus() in src/a.ts:3')
  })
})

describe('zod-v3-import', () => {
  it("flags imports from 'zod/v3' only", () => {
    const found = diagnose({
      'src/a.ts': "import { z } from 'zod'\nimport { object } from 'zod/v3'",
      'src/b.ts': "import { z } from 'zod/mini'\n// import { z } from 'zod/v3'",
    }, 'zod-v3-import')
    expect(found?.detected).toBe("imports from 'zod/v3': src/a.ts:2")
  })
})
