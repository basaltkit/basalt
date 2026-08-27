import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAiMcpServer } from '../src/index.js'
import { assertConfined, resolveWriteRoot, within, WorkspaceEscapeError } from '../src/safety.js'

const PLAN = {
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

function makeProject(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'basalt-make-')))
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'prisma'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { '@basaltkit/prisma': '^1' } }))
  writeFileSync(join(root, 'src', 'app.ts'), 'createApp({ plugins: [ prismaPlugin({}), fastifyPlugin({ routes: [] }) ] })')
  writeFileSync(
    join(root, 'prisma', 'schema.prisma'),
    'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
  )
  return root
}

const call = (
  server: ReturnType<typeof buildAiMcpServer>,
  args: Record<string, unknown>,
  callCtx?: Record<string, unknown>,
) =>
  server.handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'basalt_make', arguments: args } },
    callCtx,
  )

const isError = (res: any): boolean => res?.result?.isError === true
const text = (res: any): string => res?.result?.content?.[0]?.text ?? ''

// -------------------------------------------------------------------------

describe('safety functions (confinement)', () => {
  let base: string
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'basalt-conf-')))
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  it('within() distinguishes inside vs outside', () => {
    expect(within(base, base)).toBe(true)
    expect(within(base, join(base, 'a/b'))).toBe(true)
    expect(within(base, join(base, '..'))).toBe(false)
  })

  it('resolveWriteRoot accepts the base and inner paths', () => {
    expect(resolveWriteRoot(base, undefined)).toBe(base)
    expect(resolveWriteRoot(base, 'sub/dir')).toBe(join(base, 'sub/dir'))
  })

  it('resolveWriteRoot rejects ../ traversal and absolute paths outside', () => {
    expect(() => resolveWriteRoot(base, '../escape')).toThrow(WorkspaceEscapeError)
    expect(() => resolveWriteRoot(base, '/etc')).toThrow(WorkspaceEscapeError)
  })

  it('resolveWriteRoot rejects a symlink that escapes the base', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'basalt-outside-')))
    try {
      symlinkSync(outside, join(base, 'link'), 'dir')
      expect(() => resolveWriteRoot(base, 'link')).toThrow(WorkspaceEscapeError)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('assertConfined rejects traversal/absolute and accepts inner paths', () => {
    expect(() => assertConfined(base, ['../evil.ts'])).toThrow(WorkspaceEscapeError)
    expect(() => assertConfined(base, ['/abs/evil.ts'])).toThrow(WorkspaceEscapeError)
    expect(() => assertConfined(base, ['src/modules/widget/widget.schema.ts'])).not.toThrow()
  })
})

// -------------------------------------------------------------------------

describe('basalt_make — safety (temp-dir sandbox)', () => {
  let root: string
  beforeEach(() => {
    root = makeProject()
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('preview (default) writes ZERO files', async () => {
    const server = buildAiMcpServer({ cwd: root })
    const res = await call(server, { plan: PLAN })
    const sc = (res as any).result.structuredContent
    expect(sc.dryRun).toBe(true)
    expect(sc.preview.perFile.length).toBeGreaterThan(0)
    expect(sc.preview.perFile.every((f: any) => f.action === 'create')).toBe(true)
    // nothing on disk
    expect(existsSync(join(root, 'src', 'modules', 'widget'))).toBe(false)
  })

  it('apply writes; a second apply refuses the clash without force; force overwrites', async () => {
    const server = buildAiMcpServer({ cwd: root })
    const r1 = await call(server, { plan: PLAN, mode: 'apply' })
    expect(isError(r1)).toBe(false)
    expect(existsSync(join(root, 'src', 'modules', 'widget', 'widget.schema.ts'))).toBe(true)
    // no DB push happened (migrate not set)
    expect((r1 as any).result.structuredContent.migration).toBeUndefined()

    const r2 = await call(server, { plan: PLAN, mode: 'apply' })
    expect(isError(r2)).toBe(true)
    expect(text(r2)).toMatch(/force/i)

    const r3 = await call(server, { plan: PLAN, mode: 'apply', force: true })
    expect(isError(r3)).toBe(false)
  })

  it('does NOT run prisma db push unless migrate:true (default apply leaves migration undefined)', async () => {
    const server = buildAiMcpServer({ cwd: root })
    const res = await call(server, { plan: PLAN, mode: 'apply' })
    expect(isError(res)).toBe(false)
    expect((res as any).result.structuredContent.migration).toBeUndefined()
  })

  it('a mock elicit returning false BLOCKS the apply — nothing is written', async () => {
    const server = buildAiMcpServer({ cwd: root })
    const res = await call(server, { plan: PLAN, mode: 'apply' }, { elicit: async () => false })
    expect(isError(res)).toBe(true)
    expect(text(res)).toMatch(/cancel|not confirmed/i)
    expect(existsSync(join(root, 'src', 'modules', 'widget'))).toBe(false)
  })

  it('rejects a workspaceRoot that escapes the launch directory — before any write', async () => {
    const server = buildAiMcpServer({ cwd: root })
    const res = await call(server, { plan: PLAN, mode: 'apply', force: true, workspaceRoot: '../escape' })
    expect(isError(res)).toBe(true)
    expect(text(res)).toMatch(/escape|Refused/i)
    // nothing created in the sibling escape target
    expect(existsSync(join(root, '..', 'escape'))).toBe(false)
  })

  it('preview reports a clash as overwrite after a prior apply, still writing nothing new', async () => {
    const server = buildAiMcpServer({ cwd: root })
    await call(server, { plan: PLAN, mode: 'apply' })
    const res = await call(server, { plan: PLAN })
    const sc = (res as any).result.structuredContent
    expect(sc.preview.clashes.length).toBeGreaterThan(0)
    expect(sc.preview.perFile.some((f: any) => f.action === 'overwrite')).toBe(true)
  })
})
