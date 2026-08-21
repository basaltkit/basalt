import { describe, expect, it } from 'vitest'
import { runUpgrade, MIGRATIONS, renameMachizeScope, type UpgradeFs } from '../src/index.js'

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
})
