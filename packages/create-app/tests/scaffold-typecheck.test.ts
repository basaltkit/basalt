import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createProject } from '../src/index.js'

/**
 * The scaffold-drift net (review 2026-08-b, finding D-1): a pristine scaffold
 * MUST pass its own `pnpm typecheck`. The generated app is compiled with the
 * real tsc against the real workspace packages (declared as devDependencies of
 * create-app precisely so template ↔ package type drift fails HERE, in CI,
 * instead of in a user's first `pnpm typecheck`). D-1 itself — the template
 * emitting `LOG_LEVEL: z.string()` against loggerPlugin's LogLevel union —
 * would fail this test.
 *
 * Scaffolds live UNDER packages/create-app (gitignored) so Node module
 * resolution walks up into create-app's node_modules. Cost: one tsc run per
 * variant (~2s each).
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')
const root = join(packageDir, '.scaffold-typecheck')

const typecheck = (dir: string): string => {
  try {
    execFileSync('pnpm', ['exec', 'tsc', '-p', dir], { cwd: packageDir, encoding: 'utf8', stdio: 'pipe' })
    return ''
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scaffolded apps typecheck out of the box', () => {
  it('default preset (auth + tenancy)', async () => {
    const dir = join(root, 'default')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    await createProject({ name: 'scaffold-default', dir })
    expect(typecheck(dir)).toBe('')
  }, 60_000)

  it('full preset (billing + cli + mcp)', async () => {
    const dir = join(root, 'full')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    await createProject({ name: 'scaffold-full', dir, billing: true, cli: true, mcp: true })
    expect(typecheck(dir)).toBe('')
  }, 60_000)
})
