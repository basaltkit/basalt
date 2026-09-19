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
    expect(result.written).toEqual(['Dockerfile', '.dockerignore'])
    expect(fs.written['Dockerfile']).toContain('FROM node:22-slim')
  })

  it('skips existing files unless --force', async () => {
    const fs = memFs(['Dockerfile', '.dockerignore'])
    const skipped = await runPublish(dockerfile, fs)
    expect(skipped).toEqual({ written: [], skipped: ['Dockerfile', '.dockerignore'] })
    const forced = await runPublish(dockerfile, fs, { force: true })
    expect(forced.written).toEqual(['Dockerfile', '.dockerignore'])
  })

  it('every bundled publishable produces at least one file', () => {
    for (const p of PUBLISHABLES) expect(p.files().length).toBeGreaterThan(0)
  })
})

describe('publish dockerfile — secrets never enter the image (security)', () => {
  it('ships a .dockerignore alongside the Dockerfile that excludes .env files, keys and VCS metadata', async () => {
    const fs = memFs()
    const result = await runPublish(dockerfile, fs)
    expect(result.written).toContain('.dockerignore')
    const lines = (fs.written['.dockerignore'] ?? '').split('\n')
    for (const line of ['**/.env', '**/.env.*', '!**/.env.example', '**/.git', '**/node_modules', '**/*.pem', '**/*.key']) {
      expect(lines).toContain(line)
    }
  })

  it('excludes secrets in SUBDIRECTORIES too (.dockerignore patterns are anchored at the context root)', async () => {
    const fs = memFs()
    await runPublish(dockerfile, fs)
    const ignore = fs.written['.dockerignore'] ?? ''
    // prisma/.env is where Prisma conventionally reads DATABASE_URL from.
    for (const path of [
      '.env',
      '.env.production',
      'prisma/.env',
      'apps/api/.env.local',
      'certs/server.key',
      'config/tls/cert.pem',
      '.npmrc',
      'packages/web/.npmrc',
      '.git/config',
      'packages/web/node_modules/x/index.js',
    ]) {
      expect(dockerIgnores(ignore, path), path).toBe(true)
    }
    for (const path of ['.env.example', 'prisma/.env.example', 'src/app.ts', 'package.json', 'pnpm-lock.yaml']) {
      expect(dockerIgnores(ignore, path), path).toBe(false)
    }
  })

  it('never overwrites an existing .dockerignore without --force', async () => {
    const fs = memFs(['.dockerignore'])
    const result = await runPublish(dockerfile, fs)
    expect(result.skipped).toContain('.dockerignore')
    expect(fs.written['.dockerignore']).toBeUndefined()
  })
})

/**
 * Docker's .dockerignore semantics (moby/patternmatcher), enough for these rules:
 * patterns are anchored at the context root, `*` and `?` never cross `/`, `**`
 * spans any number of directories (including none), a pattern matching a parent
 * directory excludes everything below it, and the last matching rule wins
 * (`!` re-includes). Verified against a real `docker build` context.
 */
function dockerIgnores(dockerignore: string, path: string): boolean {
  const toRegExp = (pattern: string): RegExp => {
    let source = ''
    for (let i = 0; i < pattern.length; i++) {
      const char = pattern[i] as string
      if (char === '*' && pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          source += '(?:.*/)?'
          i += 2
        } else {
          source += '.*'
          i += 1
        }
      } else if (char === '*') source += '[^/]*'
      else if (char === '?') source += '[^/]'
      else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    return new RegExp(`^${source}$`)
  }
  const segments = path.split('/')
  const candidates = segments.map((_, i) => segments.slice(0, i + 1).join('/'))
  let ignored = false
  for (const raw of dockerignore.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const negate = line.startsWith('!')
    const matcher = toRegExp(negate ? line.slice(1) : line)
    if (candidates.some((candidate) => matcher.test(candidate))) ignored = !negate
  }
  return ignored
}
