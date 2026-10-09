import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { basaltBin, patchBasaltBin } from '../src/bin-template.js'
import { createProject } from '../src/index.js'
import { devTs, ENV_EXAMPLE_LEAD, LEGACY_ENV_EXAMPLE_LEAD } from '../src/templates.js'
import { loadProject } from '../src/project/context.js'
import { hashContent, MANIFEST_PATH } from '../src/project/manifest.js'
import { runProjectCommand } from '../src/project/run.js'
import {
  addWorkspaceExclude,
  changelogUrl,
  planUpdate,
  workspaceExcludes,
  workspaceReleaseAge,
} from '../src/project/update.js'
import { fakeRegistry, harness, hoursAgo, offlineFetch, read, write, type FakePackage } from './helpers/project.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'basalt-update-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const floorOf = (range: string): string => range.replace(/^[\^~]/, '')
const bump = (version: string, part: 'major' | 'minor' | 'patch'): string => {
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number]
  return part === 'major' ? `${major + 1}.0.0` : part === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`
}

/** A registry that answers every dependency of `dir` with its current floor, plus `overrides`. */
async function registryFor(dir: string, overrides: Record<string, FakePackage | 'down'> = {}, calls: string[] = []) {
  const packages: Record<string, FakePackage | 'down'> = {}
  for (const file of ['package.json', 'web/package.json']) {
    const text = await readFile(join(dir, file), 'utf8').catch(() => undefined)
    if (!text) continue
    const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>
    for (const deps of [pkg['dependencies'], pkg['devDependencies']]) {
      for (const [name, range] of Object.entries(deps ?? {})) packages[name] = { version: floorOf(range) }
    }
  }
  return fakeRegistry({ ...packages, ...overrides }, calls)
}

async function scaffold(name: string, options: Parameters<typeof createProject>[0] extends infer T ? Partial<T> : never = {}) {
  const dir = join(root, name)
  await createProject({ name, dir, ...options })
  // A pnpm project (lockfile present) unless a test says otherwise.
  await write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
  return dir
}

describe('update — plan, table and dry run', () => {
  it('prints current → target with patch/minor/MAJOR markers and writes nothing with --dry', async () => {
    const dir = await scaffold('dry-app')
    const before = await read(dir, 'package.json')
    const pkg = JSON.parse(before)
    const core = floorOf(pkg.dependencies['@basaltkit/core'])
    const zod = floorOf(pkg.dependencies.zod)
    const tsx = floorOf(pkg.devDependencies.tsx)
    const ts = floorOf(pkg.devDependencies.typescript)
    const h = harness(dir, {
      fetch: await registryFor(dir, {
        '@basaltkit/core': { version: bump(core, 'major') },
        zod: { version: bump(zod, 'minor') },
        tsx: { version: bump(tsx, 'patch') },
        typescript: { version: bump(ts, 'major') },
      }),
    })

    const code = await runProjectCommand(['update', '--dry'], h.deps)
    expect(code).toBe(0)
    const out = h.output()
    expect(out).toMatch(new RegExp(`@basaltkit/core\\s+\\^${core.replaceAll('.', '\\.')}\\s+→\\s+\\^${bump(core, 'major').replaceAll('.', '\\.')}\\s+MAJOR`))
    expect(out).toMatch(/zod\s+\S+\s+→\s+\S+\s+minor/)
    expect(out).toMatch(/tsx\s+\S+\s+→\s+\S+\s+patch/)
    // A third-party major is held back and explained.
    expect(out).toContain(`kept typescript ^${ts}: ${bump(ts, 'major')} is a new major — pass --major`)
    // Each framework major points at its changelog + the upgrade notes.
    expect(out).toContain(changelogUrl('@basaltkit/core'))
    expect(out).toContain('guide/whats-new#upgrading')
    expect(out).toContain('Dry run — nothing written.')
    expect(await read(dir, 'package.json')).toBe(before)
    expect(h.runs).toEqual([])
  })

  it('reports "already latest" and writes nothing when every package is current', async () => {
    const dir = await scaffold('current-app')
    const h = harness(dir, { fetch: await registryFor(dir) })
    expect(await runProjectCommand(['update', '--yes'], h.deps)).toBe(0)
    expect(h.output()).toContain('already on its latest allowed version')
    expect(h.runs).toEqual([])
  })

  it('--offline errors clearly (update needs the registry)', async () => {
    const dir = await scaffold('offline-app')
    const h = harness(dir)
    expect(await runProjectCommand(['update', '--offline'], h.deps)).toBe(1)
    expect(h.output()).toMatch(/cannot run with --offline/)
  })

  it('fails clearly when the registry is unreachable', async () => {
    const dir = await scaffold('down-app')
    const h = harness(dir, { fetch: offlineFetch })
    expect(await runProjectCommand(['update', '--yes'], h.deps)).toBe(1)
    expect(h.output()).toMatch(/Could not reach https:\/\/registry\.test/)
  })

  it('refuses to write without --yes when nobody can answer the prompt', async () => {
    const dir = await scaffold('ci-app')
    const before = await read(dir, 'package.json')
    const zod = floorOf(JSON.parse(before).dependencies.zod)
    const h = harness(dir, { fetch: await registryFor(dir, { zod: { version: bump(zod, 'patch') } }), interactive: false })
    expect(await runProjectCommand(['update'], h.deps)).toBe(1)
    expect(h.output()).toContain('Re-run with --yes')
    expect(await read(dir, 'package.json')).toBe(before)
  })

  it('asks in a terminal and writes nothing when declined', async () => {
    const dir = await scaffold('declined-app')
    const before = await read(dir, 'package.json')
    const zod = floorOf(JSON.parse(before).dependencies.zod)
    const h = harness(dir, { fetch: await registryFor(dir, { zod: { version: bump(zod, 'patch') } }), interactive: true, confirm: false })
    expect(await runProjectCommand(['update'], h.deps)).toBe(0)
    expect(await read(dir, 'package.json')).toBe(before)
  })
})

describe('update — writes', () => {
  it('updates root AND web/package.json in place, installs once, runs the codemods', async () => {
    const dir = await scaffold('ui-app', { ui: true })
    const rootBefore = await read(dir, 'package.json')
    const webBefore = await read(dir, 'web/package.json')
    const core = floorOf(JSON.parse(rootBefore).dependencies['@basaltkit/core'])
    const sdk = floorOf(JSON.parse(webBefore).dependencies['@basaltkit/sdk'])
    const react = floorOf(JSON.parse(webBefore).dependencies.react)
    const h = harness(dir, {
      fetch: await registryFor(dir, {
        '@basaltkit/core': { version: bump(core, 'minor') },
        '@basaltkit/sdk': { version: bump(sdk, 'patch') },
        react: { version: bump(react, 'minor') },
      }),
    })
    expect(await runProjectCommand(['update', '--yes'], h.deps)).toBe(0)

    const rootAfter = await read(dir, 'package.json')
    const webAfter = await read(dir, 'web/package.json')
    expect(JSON.parse(rootAfter).dependencies['@basaltkit/core']).toBe(`^${bump(core, 'minor')}`)
    expect(JSON.parse(webAfter).dependencies['@basaltkit/sdk']).toBe(`^${bump(sdk, 'patch')}`)
    expect(JSON.parse(webAfter).dependencies.react).toBe(`^${bump(react, 'minor')}`)
    // Text-level edit: exactly the changed lines differ, everything else is byte-identical.
    const changed = (a: string, b: string) => a.split('\n').filter((line, i) => line !== b.split('\n')[i])
    expect(changed(rootBefore, rootAfter)).toHaveLength(1)
    expect(changed(webBefore, webAfter)).toHaveLength(2)
    expect(h.runs).toEqual([{ command: 'pnpm', args: ['install'], cwd: dir }])
    expect(h.codemodRuns).toEqual([dir])
    expect(h.output()).toContain('Next: pnpm typecheck && pnpm test')
  })

  it('preserves the range style (^, ~, exact) and leaves unmanaged ranges alone', async () => {
    const dir = await scaffold('styles-app')
    const pkg = JSON.parse(await read(dir, 'package.json'))
    pkg.dependencies['left-pad'] = '~1.2.0'
    pkg.dependencies['exact-dep'] = '2.0.0'
    pkg.dependencies['tagged'] = 'latest'
    pkg.dependencies['local'] = 'workspace:*'
    await write(dir, 'package.json', `${JSON.stringify(pkg, null, 4)}\n`)
    const h = harness(dir, {
      fetch: await registryFor(dir, {
        'left-pad': { version: '1.3.0' },
        'exact-dep': { version: '2.0.5' },
        tagged: { version: '9.9.9' },
      }),
    })
    expect(await runProjectCommand(['update', '--yes', '--no-install'], h.deps)).toBe(0)
    const text = await read(dir, 'package.json')
    const after = JSON.parse(text)
    expect(after.dependencies['left-pad']).toBe('~1.3.0')
    expect(after.dependencies['exact-dep']).toBe('2.0.5')
    expect(after.dependencies['tagged']).toBe('latest')
    expect(after.dependencies['local']).toBe('workspace:*')
    // 4-space indentation kept.
    expect(text).toContain('\n    "dependencies": {')
    // --no-install: no install, no codemods, and the next steps say so.
    expect(h.runs).toEqual([])
    expect(h.codemodRuns).toEqual([])
    expect(h.output()).toContain('Next: pnpm install')
  })

  it('--major lets third-party packages cross a major', async () => {
    const dir = await scaffold('major-app')
    const ts = floorOf(JSON.parse(await read(dir, 'package.json')).devDependencies.typescript)
    const h = harness(dir, { fetch: await registryFor(dir, { typescript: { version: bump(ts, 'major') } }) })
    expect(await runProjectCommand(['update', '--yes', '--major', '--no-install'], h.deps)).toBe(0)
    expect(JSON.parse(await read(dir, 'package.json')).devDependencies.typescript).toBe(`^${bump(ts, 'major')}`)
    expect(h.output()).toMatch(/typescript.+MAJOR/)
  })

  it('--only=@basaltkit leaves third-party packages untouched', async () => {
    const dir = await scaffold('only-app')
    const pkg = JSON.parse(await read(dir, 'package.json'))
    const core = floorOf(pkg.dependencies['@basaltkit/core'])
    const zod = floorOf(pkg.dependencies.zod)
    const h = harness(dir, {
      fetch: await registryFor(dir, { '@basaltkit/core': { version: bump(core, 'patch') }, zod: { version: bump(zod, 'minor') } }),
    })
    expect(await runProjectCommand(['update', '--yes', '--only=@basaltkit', '--no-install'], h.deps)).toBe(0)
    const after = JSON.parse(await read(dir, 'package.json'))
    expect(after.dependencies['@basaltkit/core']).toBe(`^${bump(core, 'patch')}`)
    expect(after.dependencies.zod).toBe(pkg.dependencies.zod)
  })

  it('reports an install failure, keeps the edits and says how to revert', async () => {
    const dir = await scaffold('broken-install')
    const zod = floorOf(JSON.parse(await read(dir, 'package.json')).dependencies.zod)
    const h = harness(dir, { fetch: await registryFor(dir, { zod: { version: bump(zod, 'patch') } }), installOk: false })
    expect(await runProjectCommand(['update', '--yes'], h.deps)).toBe(1)
    expect(JSON.parse(await read(dir, 'package.json')).dependencies.zod).toBe(`^${bump(zod, 'patch')}`)
    expect(h.output()).toContain('pnpm install failed')
    expect(h.output()).toContain('git checkout -- package.json')
    expect(h.codemodRuns).toEqual([])
  })
})

describe('update — release age, majors gating, peers', () => {
  it('keeps a third-party version published inside the release-age window', async () => {
    const dir = await scaffold('fresh-app')
    const zod = floorOf(JSON.parse(await read(dir, 'package.json')).dependencies.zod)
    const h = harness(dir, { fetch: await registryFor(dir, { zod: { version: bump(zod, 'patch'), modified: hoursAgo(2) } }) })
    expect(await runProjectCommand(['update', '--yes', '--no-install'], h.deps)).toBe(0)
    expect(JSON.parse(await read(dir, 'package.json')).dependencies.zod).toBe(`^${zod}`)
    expect(h.output()).toContain('inside the release-age window')
  })

  it("honors the project's own minimumReleaseAge from pnpm-workspace.yaml", async () => {
    const dir = await scaffold('window-app')
    const yaml = await read(dir, 'pnpm-workspace.yaml')
    await write(dir, 'pnpm-workspace.yaml', `${yaml}minimumReleaseAge: 60\n`)
    const zod = floorOf(JSON.parse(await read(dir, 'package.json')).dependencies.zod)
    const h = harness(dir, { fetch: await registryFor(dir, { zod: { version: bump(zod, 'patch'), modified: hoursAgo(2) } }) })
    expect(await runProjectCommand(['update', '--yes', '--no-install'], h.deps)).toBe(0)
    // Two hours old clears a 60-minute window.
    expect(JSON.parse(await read(dir, 'package.json')).dependencies.zod).toBe(`^${bump(zod, 'patch')}`)
  })

  it('never probes @basaltkit/* when pnpm-workspace.yaml excludes the scope', async () => {
    const dir = await scaffold('probe-app')
    const calls: string[] = []
    const core = floorOf(JSON.parse(await read(dir, 'package.json')).dependencies['@basaltkit/core'])
    const fetch = await registryFor(dir, { '@basaltkit/core': { version: bump(core, 'patch'), modified: hoursAgo(1) } }, calls)
    const h = harness(dir, { fetch })
    expect(await runProjectCommand(['update', '--yes', '--no-install'], h.deps)).toBe(0)
    expect(calls.some((call) => call.startsWith('HEAD') && call.includes('basaltkit'))).toBe(false)
    expect(JSON.parse(await read(dir, 'package.json')).dependencies['@basaltkit/core']).toBe(`^${bump(core, 'patch')}`)
  })

  it('warns when a framework release expects a peer major the app is held on', async () => {
    const dir = await scaffold('peer-app')
    const pkg = JSON.parse(await read(dir, 'package.json'))
    const core = floorOf(pkg.dependencies['@basaltkit/core'])
    const h = harness(dir, {
      fetch: await registryFor(dir, {
        '@basaltkit/core': { version: bump(core, 'major'), peerDependencies: { zod: '^5.0.0' } },
        zod: { version: '5.1.0' },
      }),
    })
    expect(await runProjectCommand(['update', '--dry'], h.deps)).toBe(0)
    expect(h.output()).toMatch(/@basaltkit\/core@\S+ expects zod \^5\.0\.0, but the app will have \^4\.\S+ — re-run with --major/)
  })
})

describe('update — project tooling', () => {
  const legacy = async (name: string) =>
    readFile(join(import.meta.dirname, 'fixtures', 'legacy-bins', `${name}.ts.txt`), 'utf8')

  it('the latest legacy bins (1.9, 1.10) patch to exactly the current template', async () => {
    expect(patchBasaltBin(await legacy('2026-09-19'))).toBe(basaltBin())
    expect(patchBasaltBin(await legacy('2026-10-01'))).toBe(basaltBin())
    // Patching is idempotent and CRLF-insensitive.
    expect(patchBasaltBin(basaltBin())).toBe(basaltBin())
    expect(patchBasaltBin((await legacy('2026-10-01')).replace(/\n/g, '\r\n'))).toBe(basaltBin())
  })

  for (const version of ['2026-08-09', '2026-08-13', '2026-08-22', '2026-09-19', '2026-10-01']) {
    it(`patches an unmodified bin/basalt.ts from ${version}`, async () => {
      const dir = await scaffold(`bin-${version}`, { cli: true })
      const old = await legacy(version)
      await write(dir, 'bin/basalt.ts', old)
      await rm(join(dir, MANIFEST_PATH))
      const h = harness(dir, { fetch: await registryFor(dir) })
      expect(await runProjectCommand(['update', '--yes', '--no-install'], h.deps)).toBe(0)
      const bin = await read(dir, 'bin/basalt.ts')
      expect(bin).toContain("['update', 'add', 'doctor', 'info'].includes(process.argv[2]")
      expect(bin).not.toMatch(/^import .* from '(@basaltkit\/|\.\.\/src)/m)
      // The dev prelude: pre-boot upgrade, .env loading, the readable env error — all before the app import.
      const appImport = bin.indexOf("await import('../src/app.js').catch(explainBootFailure)")
      expect(appImport).toBeGreaterThan(0)
      for (const needle of ["if (process.argv[2] === 'upgrade')", 'process.loadEnvFile(envFile)', 'function explainBootFailure']) {
        expect(bin.indexOf(needle), needle).toBeGreaterThan(0)
        expect(bin.indexOf(needle), needle).toBeLessThan(appImport)
      }
      expect(h.output()).toContain('bin/basalt.ts: unmodified template')
      expect(h.output()).toContain('loads .env for development')
    })
  }

  it('patches the 1.9/1.10 src/dev.ts and .env.example header of an app without a manifest (dry run shows the plan)', async () => {
    const dir = await scaffold('legacy-dev', { cli: true, prisma: true })
    const oldDev = await readFile(join(import.meta.dirname, 'fixtures', 'legacy-dev', '2026-09-19.ts.txt'), 'utf8')
    const currentExample = await read(dir, '.env.example')
    const oldExample = currentExample.replace(ENV_EXAMPLE_LEAD, LEGACY_ENV_EXAMPLE_LEAD)
    expect(oldExample).not.toBe(currentExample)
    await write(dir, 'src/dev.ts', oldDev)
    await write(dir, '.env.example', oldExample)
    await write(dir, 'bin/basalt.ts', await legacy('2026-09-19'))
    await rm(join(dir, MANIFEST_PATH))

    const dry = harness(dir, { fetch: await registryFor(dir) })
    expect(await runProjectCommand(['update', '--dry'], dry.deps)).toBe(0)
    expect(dry.output()).toContain('bin/basalt.ts: unmodified template')
    expect(dry.output()).toContain('src/dev.ts: unmodified template from an earlier release — `dev` loads .env')
    expect(dry.output()).toContain('.env.example: header now says dev/CLI load .env automatically')
    expect(await read(dir, 'src/dev.ts')).toBe(oldDev)

    const h = harness(dir, { fetch: await registryFor(dir) })
    expect(await runProjectCommand(['update', '--yes', '--no-install'], h.deps)).toBe(0)
    expect(await read(dir, 'src/dev.ts')).toBe(devTs())
    expect(await read(dir, '.env.example')).toBe(currentExample)
    expect(await read(dir, 'bin/basalt.ts')).toBe(basaltBin())
  })

  it('refreshes the manifest hashes of the files it patches', async () => {
    const dir = await scaffold('manifest-dev', { cli: true })
    const oldDev = await readFile(join(import.meta.dirname, 'fixtures', 'legacy-dev', '2026-09-19.ts.txt'), 'utf8')
    await write(dir, 'src/dev.ts', oldDev)
    const h = harness(dir, { fetch: await registryFor(dir) })
    expect(await runProjectCommand(['update', '--yes', '--no-install'], h.deps)).toBe(0)
    const manifest = JSON.parse(await read(dir, MANIFEST_PATH))
    expect(manifest.files['src/dev.ts']).toBe(hashContent(devTs()))
  })

  it('prints the snippets for a customised src/dev.ts and a customised 1.10 bin', async () => {
    const dir = await scaffold('custom-dev', { cli: true })
    const customDev = `// mine\nprocess.env['NODE_ENV'] ??= 'development'\nawait import('./server.js')\n`
    const customBin = `${await legacy('2026-10-01')}// my own tweak\n`
    await write(dir, 'src/dev.ts', customDev)
    await write(dir, 'bin/basalt.ts', customBin)
    const h = harness(dir, { fetch: await registryFor(dir) })
    expect(await runProjectCommand(['update', '--yes', '--no-install'], h.deps)).toBe(0)
    expect(await read(dir, 'src/dev.ts')).toBe(customDev)
    expect(await read(dir, 'bin/basalt.ts')).toBe(customBin)
    const out = h.output()
    expect(out).toContain('src/dev.ts was customised, so it was not patched. To load .env in development:')
    expect(out).toContain("const envFile = fileURLToPath(new URL('../.env', import.meta.url))")
    expect(out).toContain('bin/basalt.ts was customised, so it was not patched. To bring it up to date:')
    // It already delegates the project commands: only the missing dev prelude is printed.
    expect(out).not.toContain('Paste this right after the shebang line')
    expect(out).toContain("Paste this after the project-commands block")
    expect(out).toContain("const { buildApp } = await import('../src/app.js').catch(explainBootFailure)")
  })

  it('leaves a .env.example without the old header alone', async () => {
    const dir = await scaffold('example-own')
    await write(dir, '.env.example', 'PORT=3000\n')
    const h = harness(dir, { fetch: await registryFor(dir) })
    expect(await runProjectCommand(['update', '--yes', '--no-install'], h.deps)).toBe(0)
    expect(await read(dir, '.env.example')).toBe('PORT=3000\n')
    expect(h.output()).not.toContain('.env.example: header')
  })

  it('prints the snippet instead of patching a customised bin/basalt.ts', async () => {
    const dir = await scaffold('custom-bin', { cli: true })
    const custom = `${await legacy('2026-09-19')}// my own tweak\n`
    await write(dir, 'bin/basalt.ts', custom)
    const h = harness(dir, { fetch: await registryFor(dir) })
    expect(await runProjectCommand(['update', '--yes', '--no-install'], h.deps)).toBe(0)
    expect(await read(dir, 'bin/basalt.ts')).toBe(custom)
    expect(h.output()).toContain('bin/basalt.ts was customised')
    expect(h.output()).toContain('const root = fileURLToPath')
    // A pre-1.10 bin lacks both preludes: both snippets, in order.
    expect(h.output()).toContain('Then paste this after the project-commands block')
  })

  it('patches a bin the manifest records as untouched and refreshes its hash', async () => {
    const dir = await scaffold('manifest-bin', { cli: true })
    const old = await legacy('2026-09-19')
    await write(dir, 'bin/basalt.ts', old)
    const manifest = JSON.parse(await read(dir, MANIFEST_PATH))
    manifest.files['bin/basalt.ts'] = hashContent(old)
    await write(dir, MANIFEST_PATH, JSON.stringify(manifest))
    const h = harness(dir, { fetch: await registryFor(dir) })
    expect(await runProjectCommand(['update', '--yes', '--no-install'], h.deps)).toBe(0)
    const after = JSON.parse(await read(dir, MANIFEST_PATH))
    expect(after.files['bin/basalt.ts']).toBe(hashContent(basaltBin()))
  })

  it('gives an old app create-basalt as a devDependency + a basalt script, and excludes it from the release-age policy', async () => {
    const dir = await scaffold('old-app')
    const pkg = JSON.parse(await read(dir, 'package.json'))
    delete pkg.devDependencies['create-basalt']
    delete pkg.scripts.basalt
    await write(dir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`)
    const yaml = (await read(dir, 'pnpm-workspace.yaml')).replace('  - create-basalt\n', '')
    await write(dir, 'pnpm-workspace.yaml', yaml)
    const h = harness(dir, { fetch: await registryFor(dir, { 'create-basalt': { version: '1.10.0' } }) })
    expect(await runProjectCommand(['update', '--yes', '--no-install'], h.deps)).toBe(0)
    const after = JSON.parse(await read(dir, 'package.json'))
    expect(after.devDependencies['create-basalt']).toBe('^1.10.0')
    expect(after.scripts.basalt).toBe('create-basalt --project')
    expect(await read(dir, 'pnpm-workspace.yaml')).toContain("  - '@basaltkit/*'\n  - create-basalt\n")
  })

  it('prints (never applies) the db:seed replacement for a 1.8–1.11 --prisma app', async () => {
    const dir = await scaffold('old-seed', { prisma: true })
    const pkg = JSON.parse(await read(dir, 'package.json'))
    pkg.scripts['db:seed'] = 'tsx prisma/seed.ts'
    await write(dir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`)
    const plan = await planUpdate(await loadProject(dir), { registry: { fetch: await registryFor(dir) } })
    const step = plan.manual.find((entry) => entry.includes('db:seed'))
    expect(step).toContain('"db:seed": "prisma db seed"')
    expect(plan.files['package.json']?.after ?? '').not.toContain('"db:seed": "prisma db seed"')
    const h = harness(dir, { fetch: await registryFor(dir) })
    expect(await runProjectCommand(['update', '--yes', '--no-install'], h.deps)).toBe(0)
    expect(h.output()).toContain('"db:seed": "prisma db seed"')
    expect(JSON.parse(await read(dir, 'package.json')).scripts['db:seed']).toBe('tsx prisma/seed.ts')
    // The current scaffold has nothing to print.
    const fresh = await scaffold('new-seed', { prisma: true })
    const freshPlan = await planUpdate(await loadProject(fresh), { registry: { fetch: await registryFor(fresh) } })
    expect(freshPlan.manual.some((entry) => entry.includes('db:seed'))).toBe(false)
  })

  it('--no-tooling leaves the project tooling alone', async () => {
    const dir = await scaffold('no-tooling', { cli: true })
    const old = await legacy('2026-09-19')
    await write(dir, 'bin/basalt.ts', old)
    const h = harness(dir, { fetch: await registryFor(dir) })
    const oldDev = await readFile(join(import.meta.dirname, 'fixtures', 'legacy-dev', '2026-09-19.ts.txt'), 'utf8')
    await write(dir, 'src/dev.ts', oldDev)
    expect(await runProjectCommand(['update', '--yes', '--no-tooling', '--no-install'], h.deps)).toBe(0)
    expect(await read(dir, 'bin/basalt.ts')).toBe(old)
    expect(await read(dir, 'src/dev.ts')).toBe(oldDev)
  })
})

describe('update — helpers', () => {
  it('reads and edits the pnpm-workspace.yaml release-age settings', () => {
    const yaml = "allowBuilds:\n  esbuild: true\nminimumReleaseAgeExclude:\n  - '@basaltkit/*'\n# note\nminimumReleaseAge: 30\n"
    expect(workspaceReleaseAge(yaml)).toBe(30)
    expect(workspaceReleaseAge('packages: []\n')).toBeUndefined()
    expect(workspaceExcludes(yaml, '@basaltkit/*')).toBe(true)
    expect(workspaceExcludes(yaml, 'create-basalt')).toBe(false)
    const patched = addWorkspaceExclude(yaml, 'create-basalt') as string
    expect(workspaceExcludes(patched, 'create-basalt')).toBe(true)
    expect(addWorkspaceExclude('packages:\n  - web\n', 'create-basalt')).toBeUndefined()
  })

  it('points each framework package at its CHANGELOG in the repo', () => {
    expect(changelogUrl('@basaltkit/auth')).toBe('https://github.com/basaltkit/basalt/blob/main/packages/auth/CHANGELOG.md')
    expect(changelogUrl('create-basalt')).toBe('https://github.com/basaltkit/basalt/blob/main/packages/create-app/CHANGELOG.md')
  })

  it('planUpdate is pure: it computes the files without writing', async () => {
    const dir = await scaffold('pure-app')
    const zod = floorOf(JSON.parse(await read(dir, 'package.json')).dependencies.zod)
    const before = await readdir(dir)
    const plan = await planUpdate(await loadProject(dir), {
      registry: { fetch: await registryFor(dir, { zod: { version: bump(zod, 'minor') } }), registry: 'https://registry.test' },
    })
    expect(plan.updates.map((entry) => entry.name)).toEqual(['zod'])
    expect(plan.files['package.json']?.after).toContain(`"zod": "^${bump(zod, 'minor')}"`)
    expect(await readdir(dir)).toEqual(before)
  })
})
