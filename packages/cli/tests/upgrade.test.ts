import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runUpgrade, MIGRATIONS, nodeUpgradeFs, renameMachizeScope, type UpgradeFs } from '../src/index.js'

function memFs(tree: Record<string, string>): UpgradeFs & { tree: Record<string, string> } {
  return {
    tree,
    async list() {
      return Object.keys(tree)
    },
    async read(path) {
      return tree[path] ?? ''
    },
    async write(path, content) {
      tree[path] = content
    },
  }
}

describe('upgrade — rename-machize-scope', () => {
  it('rewrites @machize/* to @basaltkit/* across json and source files', async () => {
    const fs = memFs({
      'package.json': '{ "dependencies": { "@machize/core": "^1.0.0" } }',
      'src/app.ts': "import { x } from '@machize/http'\nimport y from '@machize/auth'",
      'README.md': 'uses @machize/core', // not a .ts/.json → untouched
    })
    const reports = await runUpgrade([renameMachizeScope], fs, { dir: '.' })
    expect(reports[0]!.changed.sort()).toEqual(['package.json', 'src/app.ts'])
    expect(fs.tree['package.json']).toContain('@basaltkit/core')
    expect(fs.tree['src/app.ts']).toBe("import { x } from '@basaltkit/http'\nimport y from '@basaltkit/auth'")
    expect(fs.tree['README.md']).toContain('@machize/core') // untouched
  })

  it('is a no-op when nothing matches', async () => {
    const fs = memFs({ 'src/app.ts': "import { x } from '@basaltkit/http'" })
    const reports = await runUpgrade(MIGRATIONS, fs, { dir: '.' })
    expect(reports.every((r) => r.changed.length === 0)).toBe(true)
  })

  it('--dry computes edits without writing', async () => {
    const fs = memFs({ 'package.json': '"@machize/core"' })
    const reports = await runUpgrade([renameMachizeScope], fs, { dir: '.', dry: true })
    expect(reports[0]!.changed).toEqual(['package.json'])
    expect(fs.tree['package.json']).toBe('"@machize/core"') // NOT written
  })

  it('--only filters to a single migration', async () => {
    const fs = memFs({ 'package.json': '"@machize/x"' })
    const reports = await runUpgrade(MIGRATIONS, fs, { dir: '.', only: 'rename-machize-scope' })
    expect(reports).toHaveLength(1)
    expect(reports[0]!.migration).toBe('rename-machize-scope')
  })

  it('nodeUpgradeFs(baseDir) reads and writes the tree it listed, whatever process.cwd() is', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'basalt-upgrade-'))
    try {
      await mkdir(join(dir, 'src'), { recursive: true })
      await mkdir(join(dir, 'node_modules', 'x'), { recursive: true })
      await writeFile(join(dir, 'src', 'app.ts'), "import { a } from '@machize/core'\n")
      await writeFile(join(dir, 'node_modules', 'x', 'index.js'), "'@machize/core'")
      const reports = await runUpgrade(MIGRATIONS, nodeUpgradeFs(dir), { dir })
      expect(reports[0]!.changed).toEqual([join('src', 'app.ts')])
      expect(await readFile(join(dir, 'src', 'app.ts'), 'utf8')).toBe("import { a } from '@basaltkit/core'\n")
      // node_modules is never touched.
      expect(await readFile(join(dir, 'node_modules', 'x', 'index.js'), 'utf8')).toBe("'@machize/core'")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
