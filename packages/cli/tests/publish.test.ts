import { describe, expect, it } from 'vitest'
import { runPublish, PUBLISHABLES, type PublishFs } from '../src/index.js'

function memFs(existing: string[] = []): PublishFs & { written: Record<string, string> } {
  const written: Record<string, string> = {}
  const present = new Set(existing)
  return {
    written,
    async exists(path) {
      return present.has(path)
    },
    async write(path, content) {
      written[path] = content
      present.add(path)
    },
  }
}

const dockerfile = PUBLISHABLES.find((p) => p.id === 'dockerfile')!

describe('publish', () => {
  it('writes a publishable group into a fresh tree', async () => {
    const fs = memFs()
    const result = await runPublish(dockerfile, fs)
    expect(result.written).toEqual(['Dockerfile'])
    expect(fs.written['Dockerfile']).toContain('FROM node:22-slim')
  })

  it('skips existing files unless --force', async () => {
    const fs = memFs(['Dockerfile'])
    const skipped = await runPublish(dockerfile, fs)
    expect(skipped).toEqual({ written: [], skipped: ['Dockerfile'] })
    const forced = await runPublish(dockerfile, fs, { force: true })
    expect(forced.written).toEqual(['Dockerfile'])
  })

  it('every bundled publishable produces at least one file', () => {
    for (const p of PUBLISHABLES) expect(p.files().length).toBeGreaterThan(0)
  })
})
