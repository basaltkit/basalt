import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateOnlyRootConfigTs, planeConfigTs, prismaSyncCommand } from '../src/index.js'

// BK-030: with two planes, one root prisma.config.ts that can migrate is how
// `prisma migrate dev` recreated every tenant table in the central database.

const project = (rootConfig?: string) => {
  const root = mkdtempSync(join(tmpdir(), 'basalt-planes-'))
  mkdirSync(join(root, 'prisma', 'tenants'), { recursive: true })
  const header = 'datasource db {\n  provider = "postgresql"\n}\n'
  writeFileSync(join(root, 'prisma', 'schema.prisma'), header)
  writeFileSync(join(root, 'prisma', 'tenants', 'schema.prisma'), header)
  if (rootConfig !== undefined) writeFileSync(join(root, 'prisma.config.ts'), rootConfig)
  return root
}

const command = () =>
  prismaSyncCommand({
    targets: {
      central: { schemaPath: 'prisma/schema.prisma', domains: ['tenancy'] },
      tenant: { schemaPath: 'prisma/tenants/schema.prisma', domains: ['auth'] },
    },
  })

const run = async (cwd: string, flags: Record<string, boolean> = {}) => {
  const before = process.cwd()
  process.chdir(cwd)
  const lines: string[] = []
  try {
    const code = await command().handle({
      io: { log: (m: string) => void lines.push(m), error: (m: string) => void lines.push(m), table: () => {}, confirm: async () => true },
      flags,
      args: [],
    })
    return { code, out: lines.join('\n') }
  } finally {
    process.chdir(before)
  }
}

const ROOT_THAT_MIGRATES = `import { defineConfig } from 'prisma/config'
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['DATABASE_URL'] ?? '' },
})
`

describe('prisma:sync with targets — one config per plane (BK-030)', () => {
  it('prints the missing plane configs without --yes, and writes nothing', async () => {
    const root = project()
    const { out } = await run(root)
    expect(out).toContain('[central] No prisma.config.ts next to prisma/schema.prisma')
    expect(out).toContain('[tenant] No prisma.config.ts next to prisma/tenants/schema.prisma')
    expect(out).toContain(planeConfigTs('schema.prisma'))
    expect(existsSync(join(root, 'prisma', 'tenants', 'prisma.config.ts'))).toBe(false)
  })

  it('writes them with --yes, pinning schema and migrations per plane — and never overwrites one', async () => {
    const root = project()
    writeFileSync(join(root, 'prisma', 'prisma.config.ts'), '// the app own central config\n')
    const { out } = await run(root, { yes: true })
    const tenantConfig = readFileSync(join(root, 'prisma', 'tenants', 'prisma.config.ts'), 'utf8')
    expect(tenantConfig).toContain("schema: 'schema.prisma'")
    expect(tenantConfig).toContain("migrations: { path: 'migrations' }")
    expect(out).toContain('[tenant] Wrote prisma/tenants/prisma.config.ts')
    expect(readFileSync(join(root, 'prisma', 'prisma.config.ts'), 'utf8')).toBe('// the app own central config\n')
  })

  it('warns about a root config that can migrate, and offers a generate-only one (unchanged on disk)', async () => {
    const root = project(ROOT_THAT_MIGRATES)
    const { out } = await run(root)
    expect(out).toContain('prisma.config.ts at the project root declares migrations or a datasource')
    expect(out).toContain(generateOnlyRootConfigTs('prisma/schema.prisma'))
    expect(readFileSync(join(root, 'prisma.config.ts'), 'utf8')).toBe(ROOT_THAT_MIGRATES)
  })

  it('stays quiet about a root config that is already generate-only', async () => {
    const root = project(generateOnlyRootConfigTs('prisma/schema.prisma'))
    const { out } = await run(root)
    expect(out).not.toContain('at the project root')
  })

  it('the generate-only root config declares neither migrations nor a datasource', () => {
    const text = generateOnlyRootConfigTs('prisma/schema.prisma')
    expect(text).not.toMatch(/\bmigrations\s*:|\bdatasource\s*:/)
  })
  it('refuses to give two planes that share a directory one config', async () => {
    const root = project()
    writeFileSync(join(root, 'prisma', 'tenant.prisma'), 'datasource db {\n  provider = "postgresql"\n}\n')
    const before = process.cwd()
    process.chdir(root)
    const lines: string[] = []
    try {
      await prismaSyncCommand({
        targets: {
          central: { schemaPath: 'prisma/schema.prisma', domains: ['tenancy'] },
          tenant: { schemaPath: 'prisma/tenant.prisma', domains: ['auth'] },
        },
      }).handle({
        io: { log: (m: string) => void lines.push(m), error: (m: string) => void lines.push(m), table: () => {}, confirm: async () => true },
        flags: { yes: true },
        args: [],
      })
    } finally {
      process.chdir(before)
    }
    expect(lines.join('\n')).toContain('[tenant] shares prisma with another plane')
    expect(readFileSync(join(root, 'prisma', 'prisma.config.ts'), 'utf8')).toContain("schema: 'schema.prisma'")
  })
})
