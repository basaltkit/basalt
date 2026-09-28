import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { datasourceProvider, prismaSyncCommand } from '../src/sync-command.js'

/**
 * FA-070 · On MySQL a bare `String` is VARCHAR(191), and outside strict mode a
 * longer value is truncated silently. `prisma:sync` into a MySQL schema must
 * copy the package's `schema.mysql.prisma` (free-text columns widened), and say
 * so when a package has no such variant.
 */

/** A project with its own node_modules holding two fake `*-prisma` packages. */
function project(provider: string): { root: string; schema: string } {
  const root = mkdtempSync(join(tmpdir(), 'basalt-sync-mysql-'))
  mkdirSync(join(root, 'prisma'))
  const schema = join(root, 'prisma', 'schema.prisma')
  writeFileSync(schema, `datasource db {\n  provider = "${provider}"\n}\n`)

  const fake = (name: string, files: Record<string, string>) => {
    const dir = join(root, 'node_modules', '@basaltkit', name)
    mkdirSync(join(dir, 'prisma'), { recursive: true })
    const exports: Record<string, string> = {}
    for (const [file, text] of Object.entries(files)) {
      writeFileSync(join(dir, 'prisma', file), text)
      exports[`./${file}`] = `./prisma/${file}`
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@basaltkit/${name}`, exports }))
  }
  fake('audit-prisma', {
    'schema.prisma': 'model AuditEntry {\n  id      String @id\n  payload String?\n}\n',
    'schema.mysql.prisma': 'model AuditEntry {\n  id      String @id\n  payload String? @db.MediumText\n}\n',
  })
  // An installed version that predates its MySQL variant (every current package ships one).
  fake('teams-prisma', { 'schema.prisma': 'model TeamMembership {\n  userId String @id\n}\n' })
  return { root, schema }
}

async function run(root: string) {
  const rows: string[] = []
  const before = process.cwd()
  process.chdir(root)
  try {
    const code = await prismaSyncCommand({ domains: ['audit', 'teams'] }).handle({
      io: { log: (m: string) => rows.push(m), error: (m: string) => rows.push(`ERR ${m}`), confirm: async () => true },
      flags: { yes: true },
      args: [],
    } as never)
    return { code, text: rows.join('\n') }
  } finally {
    process.chdir(before)
  }
}

describe('prisma:sync on MySQL (FA-070)', () => {
  it('copies the schema.mysql.prisma variant and points at columnLimits', async () => {
    const p = project('mysql')
    const { code, text } = await run(p.root)
    expect(code).toBe(0)
    const written = readFileSync(p.schema, 'utf8')
    expect(written).toContain('payload String? @db.MediumText')
    expect(text).toContain("columnLimits: 'mysql'")
    expect(text).toContain('@basaltkit/audit-prisma')
  })

  it('falls back to the generic schema — with a warning — when a package has no MySQL variant', async () => {
    const p = project('mysql')
    const { text } = await run(p.root)
    expect(readFileSync(p.schema, 'utf8')).toContain('model TeamMembership')
    expect(text).toMatch(/teams-prisma ships no MySQL variant/)
    expect(text).toContain('upgrade it')
  })

  it('PostgreSQL and SQLite keep the generic schema, with no MySQL notes', async () => {
    for (const provider of ['postgresql', 'sqlite']) {
      const p = project(provider)
      const { text } = await run(p.root)
      const written = readFileSync(p.schema, 'utf8')
      expect(written).toContain('payload String?\n')
      expect(written).not.toContain('@db.')
      expect(text).not.toMatch(/MySQL/)
    }
  })

  it('reads the datasource provider', () => {
    expect(datasourceProvider('generator client {\n provider = "prisma-client-js"\n}\ndatasource db {\n  provider = "mysql"\n}')).toBe('mysql')
    expect(datasourceProvider('datasource db { provider = "postgresql" }')).toBe('postgresql')
    expect(datasourceProvider('model A { id String @id }')).toBeUndefined()
  })
})
