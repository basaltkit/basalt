import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * B18 · what happens when an optional peer is genuinely absent.
 *
 * The sibling suite asserts the shape of `package.json` — every adapter a peer,
 * none a dependency — which stops the duplication that caused the original bug.
 * It cannot assert the other half: that a *missing* adapter produces an
 * actionable message instead of a bare `ERR_MODULE_NOT_FOUND`.
 *
 * Inside this workspace that is untestable. Every package is installed, so
 * `import('@basaltkit/fastify')` always resolves — including from this
 * package's own `node_modules`, where fastify is a devDependency for its own
 * tests. Mocking the import would only prove the `catch` block runs; it would
 * say nothing about resolution, which is the thing that actually breaks.
 *
 * So this builds a tree outside the workspace: a **copy** of the built `dist`,
 * a `package.json`, and symlinks for the three real dependencies — with no
 * adapter anywhere. The copy is what makes it work: importing `dist` by its
 * real path leaves Node resolving from `packages/testing/node_modules`, where
 * fastify sits as a devDependency, and the fixture proves nothing. Copied, the
 * nearest `node_modules` is the sandbox's, and Node resolves exactly as it
 * would in an application that never installed an adapter.
 */

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const workspacePackages = resolve(pkgRoot, '..')

let sandbox: string

/** A package's real location in the workspace, for symlinking. */
const linkTo = (into: string, name: string): void => {
  const scope = join(into, 'node_modules', '@basaltkit')
  mkdirSync(scope, { recursive: true })
  symlinkSync(join(workspacePackages, name), join(scope, name), 'dir')
}

beforeAll(() => {
  // `test` depends on `^build` — the *dependencies* are built, this package is
  // not. CI runs `pnpm build` first so it is always there; a developer running
  // `pnpm test` in this directory alone would otherwise meet a failure with
  // nothing to do with adapters. Cheap to just make sure.
  if (!existsSync(join(pkgRoot, 'dist/index.js'))) {
    execFileSync('pnpm', ['build'], { cwd: pkgRoot, stdio: 'ignore' })
  }

  sandbox = mkdtempSync(join(tmpdir(), 'basalt-no-adapter-'))

  writeFileSync(
    join(sandbox, 'package.json'),
    JSON.stringify({ name: 'sandbox', private: true, type: 'module' }, null, 2),
  )

  // A copy, not a reference: resolution has to start from inside the sandbox.
  cpSync(join(pkgRoot, 'dist'), join(sandbox, 'testing'), { recursive: true })

  // Only the real dependencies. No @basaltkit/fastify, express or hono: that
  // absence is the whole point of the fixture.
  for (const dep of ['core', 'mailer', 'queue']) linkTo(sandbox, dep)

  writeFileSync(
    join(sandbox, 'run.mjs'),
    `import { createTestApp } from './testing/index.js'

const app = await createTestApp({ plugins: [] })
try {
  // The fastify driver connects lazily, on the first request — so this is
  // where the adapter is reached for, and where a missing one surfaces.
  await app.get('/anything')
  console.log('NO_ERROR')
} catch (error) {
  console.log('ERROR:' + String(error?.message ?? error))
} finally {
  await app.app.shutdown()
}
`,
  )
})

afterAll(() => {
  if (sandbox) rmSync(sandbox, { recursive: true, force: true })
})

describe('F-34 · the adapter is not installed', () => {
  it('says which package to install, and names this one', () => {
    const out = execFileSync(process.execPath, ['run.mjs'], {
      cwd: sandbox,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    expect(out).not.toContain('NO_ERROR')
    // The message a developer actually reads. `ERR_MODULE_NOT_FOUND` names a
    // file path inside node_modules and leaves them to work out which package
    // it belonged to and why it was not there.
    expect(out).toContain('@basaltkit/fastify')
    expect(out).toContain('optional peer')
    expect(out).not.toContain('ERR_MODULE_NOT_FOUND')
  })

  it('would not pass if the adapter were there', () => {
    // The fixture is only worth having if it can tell the two apart. With the
    // adapter linked in, the same script reaches a different failure — the
    // token is unregistered because no `fastifyPlugin` was passed — and none of
    // the assertions above would hold.
    linkTo(sandbox, 'fastify')
    try {
      const out = execFileSync(process.execPath, ['run.mjs'], {
        cwd: sandbox,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(out).toContain('No provider registered for token')
      expect(out).not.toContain('optional peer')
    } finally {
      rmSync(join(sandbox, 'node_modules/@basaltkit/fastify'), { force: true })
    }
  })
})
