import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectProject, runMake, type ArchitecturePlan } from '../src/index.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'basalt-preview-'))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'prisma'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@basaltkit/prisma': '^1' } }))
  writeFileSync(join(root, 'src', 'app.ts'), 'createApp({ plugins: [ prismaPlugin({}), fastifyPlugin({ routes: [] }) ] })')
  writeFileSync(
    join(root, 'prisma', 'schema.prisma'),
    'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
  )
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const plan: ArchitecturePlan = {
  schemaVersion: 1,
  request: 'add a widget module',
  summary: 'Widget',
  entities: [{ name: 'Widget', fields: [{ name: 'title', type: 'String' }], tenantScoped: false }],
  steps: [{ order: 1, title: 'scaffold', kind: 'generator', detail: '', command: 'basalt make:resource Widget --prisma' }],
  permissions: [],
  auditEvents: [],
  tenantScoped: false,
  warnings: [],
}

describe('runMake dry-run preview', () => {
  it('produces a per-file plan with create actions + unified diffs, and writes NOTHING', async () => {
    const res = await runMake(detectProject(root), plan, { dryRun: true, baseDir: root })
    expect(res.dryRun).toBe(true)
    expect(res.preview).toBeDefined()
    expect(res.preview!.perFile.length).toBeGreaterThan(0)
    expect(res.preview!.perFile.every((f) => f.action === 'create')).toBe(true)
    expect(res.preview!.clashes).toEqual([])
    // unified diff format for a new file (all additions)
    const schemaFile = res.preview!.perFile.find((f) => f.path.endsWith('widget.schema.ts'))!
    expect(schemaFile.diff).toContain('+++ b/')
    expect(schemaFile.diff).toContain('@@ ')
    // absolutely nothing on disk
    expect(existsSync(join(root, 'src', 'modules', 'widget'))).toBe(false)
  })

  it('flags a clash as overwrite with a diff, and still writes nothing', async () => {
    const target = join(root, 'src', 'modules', 'widget', 'widget.schema.ts')
    mkdirSync(join(root, 'src', 'modules', 'widget'), { recursive: true })
    writeFileSync(target, 'export const old = 1\n')

    const res = await runMake(detectProject(root), plan, { dryRun: true, baseDir: root })
    const clash = res.preview!.perFile.find((f) => f.path.endsWith('widget.schema.ts'))!
    expect(clash.action).toBe('overwrite')
    expect(res.preview!.clashes).toContain('src/modules/widget/widget.schema.ts')
    expect(clash.diff).toContain('-export const old = 1')

    // the pre-existing file is untouched
    expect(readFileSync(target, 'utf8')).toBe('export const old = 1\n')
  })
})
