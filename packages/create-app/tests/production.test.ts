import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DOCKERFILE as CLI_DOCKERFILE, PUBLISHABLES } from '@basaltkit/cli'
import { createProject } from '../src/index.js'
import { loadProject } from '../src/project/context.js'
import { runDoctor } from '../src/project/doctor.js'
import { LEGACY_PRISMA_OUTPUT, planProductionPath, RUNS_TSX } from '../src/project/production.js'
import { DOCKERFILE, DOCKERIGNORE, PRODUCTION_ENTRY } from '../src/stubs.js'
import { BUILD_SCRIPT, envPrefix, START_SCRIPT } from '../src/templates.js'
import { read, write } from './helpers/project.js'

/**
 * The production path (BK-026): a scaffold builds with tsc and runs on plain
 * node, the Dockerfile `basalt publish` ships is the one the scaffold ships,
 * `update` offers what an older app lacks without rewriting `start`, and
 * `doctor` flags the gaps statically.
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'basalt-production-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('one Dockerfile, one entry', () => {
  it('src/stubs.ts is the verbatim copy of @basaltkit/cli src/stubs.ts (run `pnpm sync-stubs`)', () => {
    const source = readFileSync(join(packageDir, '..', 'cli', 'src', 'stubs.ts'), 'utf8')
    const copy = readFileSync(join(packageDir, 'src', 'stubs.ts'), 'utf8')
    expect(copy.slice(copy.indexOf('\n') + 1)).toBe(source)
  })

  it('`basalt publish dockerfile` writes the Dockerfile and .dockerignore the scaffold ships', async () => {
    const dir = join(root, 'same')
    await createProject({ name: 'same', dir })
    const files = PUBLISHABLES.find((p) => p.id === 'dockerfile')?.files() ?? []
    expect(files.find((f) => f.path === 'Dockerfile')?.content).toBe(await read(dir, 'Dockerfile'))
    expect(files.find((f) => f.path === '.dockerignore')?.content).toBe(await read(dir, '.dockerignore'))
    expect(CLI_DOCKERFILE).toBe(DOCKERFILE)
  })

  it("the Dockerfile CMD runs exactly the scaffold's `start` entry, with no tsx", async () => {
    const dir = join(root, 'entry')
    await createProject({ name: 'entry', dir })
    const pkg = JSON.parse(await read(dir, 'package.json'))
    expect(pkg.scripts.start).toBe(START_SCRIPT)
    expect(pkg.scripts.start).toContain(PRODUCTION_ENTRY)
    expect(pkg.scripts.build).toBe(BUILD_SCRIPT)
    expect(DOCKERFILE).toContain(`CMD ["node", "--enable-source-maps", "${PRODUCTION_ENTRY}"]`)
    expect(DOCKERFILE).toContain('RUN pnpm run build')
    expect(DOCKERFILE).toContain('USER node')
    const instructions = DOCKERFILE.split('\n').filter((line) => !line.startsWith('#'))
    expect(instructions.join('\n')).not.toMatch(/\btsx\b/)
    expect(RUNS_TSX.test(pkg.scripts.start)).toBe(false)
    expect(RUNS_TSX.test(pkg.scripts['start:dev'])).toBe(true)
    // tsconfig.build.json: src only, rootDir `.` → dist/src/server.js.
    const build = JSON.parse(await read(dir, 'tsconfig.build.json'))
    expect(build).toEqual({
      extends: './tsconfig.json',
      compilerOptions: { noEmit: false, rootDir: '.', outDir: 'dist', sourceMap: true },
      include: ['src'],
    })
    expect(`${build.compilerOptions.outDir}/src/server.js`).toBe(PRODUCTION_ENTRY)
  })

  it('a --prisma scaffold resolves its client through the #db/* alias and declares client-runtime-utils', async () => {
    const dir = join(root, 'db')
    await createProject({ name: 'db', dir, prisma: true })
    const pkg = JSON.parse(await read(dir, 'package.json'))
    expect(pkg.imports).toEqual({ '#db/*': './generated/prisma/*' })
    expect(pkg.dependencies['@prisma/client-runtime-utils']).toBe(pkg.dependencies['@prisma/client'])
    expect(LEGACY_PRISMA_OUTPUT.test(await read(dir, 'prisma/schema.prisma'))).toBe(false)
    expect(await read(dir, 'src/db.ts')).toContain("from '#db/client.js'")
    // pnpm 11 fails the install (ERR_PNPM_IGNORED_BUILDS) on an unapproved build.
    const workspace = await read(dir, 'pnpm-workspace.yaml')
    expect(workspace).toMatch(/^ {2}'@prisma\/engines': true$/m)
    expect(workspace).toMatch(/^ {2}prisma: true$/m)
    // Without --prisma there is no alias to carry, and nothing Prisma to approve.
    await createProject({ name: 'plain', dir: join(root, 'plain') })
    expect(JSON.parse(await read(join(root, 'plain'), 'package.json')).imports).toBeUndefined()
    expect(await read(join(root, 'plain'), 'pnpm-workspace.yaml')).not.toContain('prisma')
  })
})

/** An app as create-basalt scaffolded it before the production path existed. */
async function legacyApp(name: string, options: { prisma?: boolean } = {}): Promise<string> {
  const dir = join(root, name)
  await createProject({ name, dir, ...options })
  const pkg = JSON.parse(await read(dir, 'package.json'))
  pkg.scripts = { ...pkg.scripts, start: 'tsx src/server.ts' }
  delete pkg.scripts.build
  delete pkg.scripts['start:dev']
  delete pkg.imports
  if (pkg.dependencies) delete pkg.dependencies['@prisma/client-runtime-utils']
  await write(dir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`)
  for (const file of ['tsconfig.build.json', 'Dockerfile']) rmSync(join(dir, file), { force: true })
  if (options.prisma) {
    const schema = await read(dir, 'prisma/schema.prisma')
    await write(dir, 'prisma/schema.prisma', schema.replace('output   = "../generated/prisma"', 'output   = "../src/generated/prisma"'))
  }
  await write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
  return dir
}

describe('update offers the production path to an older app', () => {
  it('adds tsconfig.build.json, a build script and the Dockerfile — and never rewrites start', async () => {
    const dir = await legacyApp('old')
    const before = await read(dir, 'package.json')
    rmSync(join(dir, '.dockerignore'))
    const plan = await planProductionPath(dir, before)
    expect(Object.keys(plan.files).sort()).toEqual(['.dockerignore', 'Dockerfile', 'tsconfig.build.json'])
    expect(plan.files['Dockerfile']).toBe(DOCKERFILE)
    expect(plan.files['.dockerignore']).toBe(DOCKERIGNORE)
    const after = JSON.parse(plan.packageJsonText)
    expect(after.scripts.build).toBe(BUILD_SCRIPT)
    expect(after.scripts.start).toBe('tsx src/server.ts')
    expect(after.scripts['start:dev']).toBeUndefined()
    expect(plan.manual.join('\n')).toContain(`"start": "${START_SCRIPT}"`)
  })

  it('keeps an existing build script, Dockerfile and .dockerignore as they are', async () => {
    const dir = await legacyApp('custom')
    const pkg = JSON.parse(await read(dir, 'package.json'))
    pkg.scripts.build = 'tsup'
    pkg.scripts.start = 'node dist/index.js'
    const text = `${JSON.stringify(pkg, null, 2)}\n`
    await write(dir, 'Dockerfile', 'FROM scratch\n')
    const plan = await planProductionPath(dir, text)
    expect(Object.keys(plan.files)).toEqual(['tsconfig.build.json'])
    expect(plan.packageJsonText).toBe(text)
    expect(plan.manual).toEqual([])
  })

  it('a legacy Prisma layout gets client-runtime-utils and the move instructions — not a Dockerfile that cannot work', async () => {
    const dir = await legacyApp('oldprisma', { prisma: true })
    const plan = await planProductionPath(dir, await read(dir, 'package.json'))
    expect(plan.files['Dockerfile']).toBeUndefined()
    const pkg = JSON.parse(plan.packageJsonText)
    expect(pkg.dependencies['@prisma/client-runtime-utils']).toBe(pkg.dependencies['@prisma/client'])
    expect(plan.manual.join('\n')).toContain('output = "../generated/prisma"')
    expect(plan.manual.join('\n')).toContain("import { PrismaClient } from '#db/client.js'")
  })

  it('offers the (pnpm) Dockerfile to pnpm apps only', async () => {
    const dir = await legacyApp('npmapp')
    const plan = await planProductionPath(dir, await read(dir, 'package.json'), 'npm')
    expect(plan.files['Dockerfile']).toBeUndefined()
    expect(plan.files['tsconfig.build.json']).toBeDefined()
  })
})

describe('doctor checks the production path statically', () => {
  const findings = async (dir: string) =>
    (await runDoctor(await loadProject(dir), { offline: true, env: {}, nodeVersion: '24.1.0' })).filter((f) => f.area === 'build')

  it('is quiet on a fresh scaffold', async () => {
    const dir = join(root, 'fresh')
    await createProject({ name: 'fresh', dir })
    await write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
    expect(await findings(dir)).toEqual([])
  })

  it('warns on a tsx start, a missing build script and a legacy Prisma layout', async () => {
    const dir = await legacyApp('legacy', { prisma: true })
    const messages = (await findings(dir)).map((f) => `${f.level} ${f.message}`)
    expect(messages.some((m) => m.startsWith('warn `start` runs tsx'))).toBe(true)
    expect(messages.some((m) => m.startsWith('warn No `build` script'))).toBe(true)
    expect(messages.some((m) => m.includes('generated under src/'))).toBe(true)
    expect(messages.some((m) => m.includes('@prisma/client-runtime-utils'))).toBe(true)
  })

  it('notes a dist/ older than src/', async () => {
    const dir = join(root, 'stale')
    await createProject({ name: 'stale', dir })
    await write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
    await write(dir, PRODUCTION_ENTRY, '')
    const { utimes } = await import('node:fs/promises')
    const old = new Date('2020-01-01T00:00:00Z')
    await utimes(join(dir, PRODUCTION_ENTRY), old, old)
    const stale = await findings(dir)
    expect(stale).toEqual([{ level: 'info', area: 'build', message: expect.stringContaining(`${PRODUCTION_ENTRY} is older than src/`) }])
  })
})

/**
 * End to end: scaffold, `tsc -p tsconfig.build.json`, `node dist/src/server.js`,
 * poll /health — the path the Dockerfile takes, minus Docker. Scaffolds live
 * UNDER packages/create-app (gitignored) so Node resolves the workspace
 * packages through create-app's node_modules, like scaffold-typecheck.test.ts.
 */
const e2eRoot = join(packageDir, '.scaffold-production')
const bin = (name: string): string => join(packageDir, 'node_modules', '.bin', name)

afterAll(() => {
  rmSync(e2eRoot, { recursive: true, force: true })
})

function freshDir(name: string): string {
  const dir = join(e2eRoot, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

function build(dir: string): string {
  try {
    execFileSync(bin('tsc'), ['-p', 'tsconfig.build.json'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
    return ''
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/** The production configuration: no .env loading, NODE_ENV production. */
const prodEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  PATH: process.env['PATH'],
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  APP_SECRET: 'q7Vd2LmX9pRt4Kw8Nz3Bc6Hj1Fy5Gs0Ua7Ee2Oi9Mn4Pl8Rk3Xb6Tc1Wz5Yv0Qh',
  ...extra,
})

/** Runs `node dist/src/server.js` until /health answers (or the deadline passes), then stops it. */
async function bootAndProbe(dir: string, env: NodeJS.ProcessEnv): Promise<{ status?: number; body?: unknown; log: string }> {
  const port = await freePort()
  const child = spawn(process.execPath, ['--enable-source-maps', PRODUCTION_ENTRY], {
    cwd: dir,
    env: { ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()))
  let exited = false
  child.once('exit', () => (exited = true))
  try {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !exited) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`)
        return { status: res.status, body: await res.json(), log }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    return { log }
  } finally {
    child.kill('SIGTERM')
  }
}

describe('a scaffold builds and runs on plain node (no tsx)', () => {
  it('default preset: build → node dist/src/server.js → GET /health', async () => {
    const dir = freshDir('default')
    await createProject({ name: 'prod-default', dir })
    expect(build(dir)).toBe('')
    expect(existsSync(join(dir, PRODUCTION_ENTRY))).toBe(true)
    expect(existsSync(join(dir, 'dist', 'tests'))).toBe(false)
    const result = await bootAndProbe(dir, prodEnv({}))
    expect(result.status, result.log).toBe(200)
    expect(result.body).toMatchObject({ ok: true })
  }, 90_000)

  it('full preset (billing + cli + mcp): the dev-only packages are not needed to start', async () => {
    const dir = freshDir('full')
    await createProject({ name: 'prod-full', dir, billing: true, cli: true, mcp: true })
    expect(build(dir)).toBe('')
    // bin/ (generators, the AI bridge) is not part of the build.
    expect(existsSync(join(dir, 'dist', 'bin'))).toBe(false)
    const result = await bootAndProbe(dir, prodEnv({}))
    expect(result.status, result.log).toBe(200)
  }, 90_000)
})

const prismaCli = bin('prisma')
const databaseUrl = process.env['BASALT_SCAFFOLD_DATABASE_URL']

describe.skipIf(!existsSync(prismaCli))(
  `a --prisma scaffold builds and loads its client on plain node${existsSync(prismaCli) ? '' : ' [skipped: no prisma CLI]'}`,
  () => {
    it('generate → build → node imports dist/src/app.js (client via #db/*, runtime utils resolvable)', async () => {
      const dir = freshDir('prisma')
      await createProject({ name: 'prod-prisma', dir, prisma: true, billing: true })
      execFileSync(prismaCli, ['generate'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
      expect(existsSync(join(dir, 'generated', 'prisma', 'runtime'))).toBe(true)
      expect(build(dir)).toBe('')
      // The whole module graph, the Prisma client included, loads under plain
      // node — the import fails with ERR_MODULE_NOT_FOUND otherwise. No query
      // runs, so no database is needed.
      const out = execFileSync(
        process.execPath,
        ['--input-type=module', '-e', "const m = await import('./dist/src/app.js'); console.log(typeof m.buildApp)"],
        { cwd: dir, encoding: 'utf8', env: prodEnv({ DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused' }) },
      )
      expect(out.trim()).toBe('function')
    }, 120_000)

    it.skipIf(!databaseUrl)(
      `boots against PostgreSQL and answers /health${databaseUrl ? '' : ' [skipped: set BASALT_SCAFFOLD_DATABASE_URL to a disposable database]'}`,
      async () => {
        const dir = freshDir('prisma-boot')
        await createProject({ name: 'prod-prisma-boot', dir, prisma: true })
        // The app-prefixed name: prisma.config.ts reads it first, and the
        // scaffold's .env sets it to a local default that must not win.
        const url = { [`${envPrefix('prod-prisma-boot')}_DATABASE_URL`]: databaseUrl as string }
        const env = { ...process.env, ...url }
        execFileSync(prismaCli, ['generate'], { cwd: dir, stdio: 'pipe', env })
        // One migration from the empty database to the schema, then deploy it:
        // the app boots with assertMigrated, which needs _prisma_migrations.
        const sql = execFileSync(prismaCli, ['migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.prisma', '--script'], {
          cwd: dir,
          encoding: 'utf8',
          env,
        })
        mkdirSync(join(dir, 'prisma', 'migrations', '0_init'), { recursive: true })
        writeFileSync(join(dir, 'prisma', 'migrations', '0_init', 'migration.sql'), sql)
        writeFileSync(join(dir, 'prisma', 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n')
        execFileSync(prismaCli, ['migrate', 'deploy'], { cwd: dir, stdio: 'pipe', env })
        expect(build(dir)).toBe('')
        const result = await bootAndProbe(dir, prodEnv(url))
        expect(result.status, result.log).toBe(200)
      },
      120_000,
    )
  },
)
