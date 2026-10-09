import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
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

/** A `node dist/src/server.js` child process, once /health answered or it exited. */
interface Server {
  readonly baseUrl: string
  /** True when /health answered before the process exited (or the deadline). */
  readonly ready: boolean
  /** The exit code, once the process has exited (null while it runs). */
  readonly exitCode: () => number | null
  readonly log: () => string
  /** SIGTERM (a graceful shutdown in the scaffold), then the exit code. */
  readonly stop: () => Promise<number | null>
}

/** Starts `node dist/src/server.js` and waits until /health answers, the process exits, or 30s pass. */
async function startServer(dir: string, env: NodeJS.ProcessEnv): Promise<Server> {
  const port = await freePort()
  const child = spawn(process.execPath, ['--enable-source-maps', PRODUCTION_ENTRY], {
    cwd: dir,
    env: { ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (chunk: Buffer) => (log += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()))
  let exitCode: number | null = null
  const exited = new Promise<number | null>((resolve) =>
    child.once('exit', (code, signal) => {
      exitCode = code ?? (signal ? 128 : null)
      resolve(exitCode)
    }),
  )
  const baseUrl = `http://127.0.0.1:${port}`
  let ready = false
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && exitCode === null) {
    try {
      await fetch(`${baseUrl}/health`)
      ready = true
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  return {
    baseUrl,
    ready,
    exitCode: () => exitCode,
    log: () => log,
    stop: async () => {
      if (exitCode === null) child.kill('SIGTERM')
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
      try {
        return await exited
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

/** Runs `node dist/src/server.js` until /health answers (or the deadline passes), then stops it. */
async function bootAndProbe(dir: string, env: NodeJS.ProcessEnv): Promise<{ status?: number; body?: unknown; log: string }> {
  const server = await startServer(dir, env)
  try {
    if (!server.ready) return { log: server.log() }
    const res = await fetch(`${server.baseUrl}/health`)
    return { status: res.status, body: await res.json(), log: server.log() }
  } finally {
    await server.stop()
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

  },
)

/**
 * The whole --prisma path against a REAL PostgreSQL server, through the app's
 * own package.json scripts (run like `pnpm run` would: the script string plus
 * the extra arguments, the app's bins on PATH, no URL exported):
 *
 * - production path: scaffold → the generated .env / prisma.config.ts →
 *   `db:generate` → build → the assertMigrated boot refusal → `db:migrate
 *   --name init --create-only` → `db:deploy` (`migrate deploy`) → `db:seed` →
 *   `node dist/src/server.js` → requests that read and write the database →
 *   graceful shutdown;
 * - development path, in a second scaffold: `db:migrate --name init` on a
 *   database that does not exist yet (`migrate dev` creates it, creates the
 *   first migration and applies it in one step) → `db:migrate` with nothing to
 *   do → a schema change → `db:migrate --name add_note` → `db:generate` (Prisma
 *   7's `migrate dev` does not generate the client) → `db:seed`.
 *
 * Each run works in its own throwaway databases, dropped here, so the server
 * behind BASALT_SCAFFOLD_DATABASE_URL needs CREATEDB (Prisma's shadow database
 * for `migrate dev` needs it too; the CI user is the container's superuser).
 *
 * Not verified here: `db:migrate` WITHOUT `--name` on a schema change. Prisma
 * then prompts for the migration name and blocks even with stdin closed, so it
 * cannot run unattended — every call below passes `--name`, and a 2-minute
 * timeout turns an unexpected prompt into a failure instead of a hang. Nor the
 * prompts `migrate dev` shows for a destructive change or a drifted database
 * (reset confirmation), which need a terminal.
 *
 * Skipped without BASALT_SCAFFOLD_DATABASE_URL — unless
 * BASALT_SCAFFOLD_PG_REQUIRED=1 (the CI `scaffold-postgres` job), where a
 * missing URL FAILS the suite instead of silently skipping it.
 */
const pgRequired = process.env['BASALT_SCAFFOLD_PG_REQUIRED'] === '1'
const runPg = Boolean(databaseUrl) || pgRequired

describe.skipIf(!runPg)(
  `a --prisma scaffold against real PostgreSQL${runPg ? '' : ' [skipped: set BASALT_SCAFFOLD_DATABASE_URL to a server this suite may CREATE DATABASE on]'}`,
  () => {
    const name = 'prod-prisma-pg'
    const urlKey = `${envPrefix(name)}_DATABASE_URL`
    const dir = join(e2eRoot, 'prisma-pg')
    const database = `basalt_scaffold_e2e_${process.pid}_${Date.now().toString(36)}`
    let admin: pg.Client | undefined
    let appUrl = ''

    /** A developer's shell: no stray database URL, no NODE_ENV, the app's bins on PATH (as `pnpm run` puts them). */
    const devShell = (): NodeJS.ProcessEnv => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${join(packageDir, 'node_modules', '.bin')}${delimiter}${process.env['PATH'] ?? ''}`,
      }
      for (const key of ['DATABASE_URL', urlKey, 'NODE_ENV', 'BASALT_SCAFFOLD_DATABASE_URL']) delete env[key]
      return env
    }
    const prismaIn = (cwd: string, args: string[]): string => {
      try {
        return execFileSync(prismaCli, args, { cwd, encoding: 'utf8', stdio: 'pipe', env: devShell() })
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string; message: string }
        throw new Error(`prisma ${args.join(' ')} failed:\n${e.stdout ?? ''}${e.stderr ?? ''}\n${e.message}`)
      }
    }
    const prisma = (args: string[]): string => prismaIn(dir, args)
    /**
     * `pnpm run <script> -- <args>` without pnpm: the app's own script string
     * from package.json, the arguments appended, the app's bins on PATH. A
     * prompt (stdin is closed) fails on the timeout instead of hanging.
     */
    const runScript = (cwd: string, script: string, args: string[] = []): string => {
      const command = (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts?.[script]
      if (command === undefined) throw new Error(`package.json has no "${script}" script`)
      try {
        return execFileSync('/bin/sh', ['-c', `${command} "$@"`, script, ...args], {
          cwd,
          encoding: 'utf8',
          stdio: 'pipe',
          input: '',
          timeout: 120_000,
          env: devShell(),
        })
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string; message: string }
        throw new Error(`${script} (${command} ${args.join(' ')}) failed:\n${e.stdout ?? ''}${e.stderr ?? ''}\n${e.message}`)
      }
    }
    const queryAt = async <T extends Record<string, unknown>>(url: string, sql: string): Promise<T[]> => {
      const client = new pg.Client({ connectionString: url })
      await client.connect()
      try {
        return (await client.query<T>(sql)).rows
      } finally {
        await client.end()
      }
    }
    const query = <T extends Record<string, unknown>>(sql: string): Promise<T[]> => queryAt<T>(appUrl, sql)
    /** The URL of another database on the same server. */
    const urlOf = (name: string): string => {
      const url = new URL(databaseUrl as string)
      url.pathname = `/${name}`
      return url.toString()
    }
    const devDir = join(e2eRoot, 'prisma-pg-dev')
    // Never created here: `migrate dev` creates it, as for a developer.
    const devDatabase = `${database}_dev`
    /** The production process environment: no .env, NODE_ENV=production, the URL under the app's prefixed name. */
    const production = (): NodeJS.ProcessEnv => prodEnv({ [urlKey]: appUrl })

    beforeAll(async () => {
      if (!databaseUrl) {
        throw new Error(
          'BASALT_SCAFFOLD_PG_REQUIRED=1 but BASALT_SCAFFOLD_DATABASE_URL is not set: this job must run the --prisma scaffold against a real PostgreSQL server.',
        )
      }
      if (!existsSync(prismaCli)) throw new Error(`No prisma CLI at ${prismaCli} — run pnpm install.`)
      admin = new pg.Client({ connectionString: databaseUrl })
      await admin.connect()
      await admin.query(`CREATE DATABASE "${database}"`)
      appUrl = urlOf(database)
    }, 60_000)

    afterAll(async () => {
      if (!admin) return
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
        await admin.query(`DROP DATABASE IF EXISTS "${devDatabase}" WITH (FORCE)`)
      } finally {
        await admin.end()
      }
    }, 60_000)

    it('scaffolds with --prisma: .env, prisma.config.ts, the db:* scripts and assertMigrated agree', async () => {
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      await createProject({ name, dir, prisma: true, billing: true })
      const env = await read(dir, '.env')
      expect(env).toMatch(new RegExp(`^${urlKey}=postgres`, 'm'))
      // prisma.config.ts reads the prefixed name first, like src/env.ts.
      expect(await read(dir, 'prisma.config.ts')).toContain(`process.env['${urlKey}'] ?? process.env['DATABASE_URL']`)
      expect(await read(dir, 'src/app.ts')).toContain('assertMigrated: true')
      const pkg = JSON.parse(await read(dir, 'package.json'))
      expect(pkg.scripts).toMatchObject({
        'db:generate': 'prisma generate',
        'db:migrate': 'prisma migrate dev',
        'db:deploy': 'prisma migrate deploy',
        'db:seed': 'prisma db seed',
      })
      // Point the generated .env at this run's database — the developer's edit.
      // The CLI below gets no URL from the environment: only .env can supply it.
      await write(dir, '.env', env.replace(new RegExp(`^${urlKey}=.*$`, 'm'), `${urlKey}=${appUrl}`))
    })

    it('db:generate (prisma generate) → tsc build', () => {
      runScript(dir, 'db:generate')
      expect(existsSync(join(dir, 'generated', 'prisma', 'runtime'))).toBe(true)
      expect(build(dir)).toBe('')
      expect(existsSync(join(dir, PRODUCTION_ENTRY))).toBe(true)
    }, 120_000)

    it('assertMigrated refuses to boot the database before it is migrated', async () => {
      const server = await startServer(dir, production())
      const code = await server.stop()
      expect(server.ready, server.log()).toBe(false)
      expect(code, server.log()).not.toBe(0)
      expect(server.log()).toContain('Cannot start:')
      expect(server.log()).toContain('_prisma_migrations')
      // The URL's password never reaches the log.
      expect(server.log()).not.toContain(`:${new URL(appUrl).password}@`)
    }, 60_000)

    it('db:migrate writes the first migration, db:deploy applies it', async () => {
      // `pnpm db:migrate --name init`, minus the apply: --create-only leaves the
      // database empty, so the production command below is the one that migrates.
      runScript(dir, 'db:migrate', ['--name', 'init', '--create-only'])
      const migrations = readdirSync(join(dir, 'prisma', 'migrations')).filter((entry) => entry.endsWith('_init'))
      expect(migrations).toHaveLength(1)
      const sql = readFileSync(join(dir, 'prisma', 'migrations', migrations[0]!, 'migration.sql'), 'utf8')
      expect(sql).toContain('CREATE TABLE "tenants"')
      expect(sql).toContain('CREATE TABLE "auth_users"')
      expect(sql).toContain('CREATE TABLE "subscriptions"')
      expect(await query(`SELECT to_regclass('public.tenants')::text AS t`)).toEqual([{ t: null }])

      runScript(dir, 'db:deploy')
      const applied = await query<{ migration_name: string; finished: boolean }>(
        'SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations',
      )
      expect(applied).toEqual([{ migration_name: migrations[0], finished: true }])
      expect(prisma(['migrate', 'status'])).toContain('Database schema is up to date')
    }, 120_000)

    it('db:seed creates the demo tenant (prisma db seed loads .env through prisma.config.ts)', async () => {
      runScript(dir, 'db:seed')
      // An upsert: seeding twice is safe.
      runScript(dir, 'db:seed')
      expect(await query('SELECT id FROM tenants')).toEqual([{ id: 'demo' }])
    }, 120_000)

    it('node dist/src/server.js boots on the migrated database and serves requests that hit it', async () => {
      const server = await startServer(dir, production())
      try {
        expect(server.ready, server.log()).toBe(true)
        const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
          const res = await fetch(`${server.baseUrl}${path}`, {
            method: init.method ?? 'GET',
            headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          })
          const text = await res.text()
          return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
        }

        expect(await call('/health')).toMatchObject({ status: 200, body: { ok: true, tenant: null } })
        // The tenant source reads the `tenants` table: the seeded id resolves,
        // an unknown one resolves to no tenant (tenancy is not `required` here).
        expect(await call('/health', { headers: { 'x-tenant-id': 'demo' } })).toMatchObject({ status: 200, body: { tenant: 'demo' } })
        expect(await call('/health', { headers: { 'x-tenant-id': 'no-such-tenant' } })).toMatchObject({ status: 200, body: { tenant: null } })

        const credentials = { email: 'e2e@example.com', password: 'Correct-Horse-9-Battery-Staple' }
        expect((await call('/auth/register', { method: 'POST', body: credentials })).status).toBe(202)
        expect(await query('SELECT email FROM auth_users')).toEqual([{ email: credentials.email }])

        const login = await call('/auth/login', { method: 'POST', body: credentials })
        expect(login.status, JSON.stringify(login.body)).toBe(200)
        const { accessToken, refreshToken } = login.body as { accessToken: string; refreshToken: string }
        expect(typeof accessToken).toBe('string')
        expect(typeof refreshToken).toBe('string')
        const wrong = await call('/auth/login', { method: 'POST', body: { ...credentials, password: 'Wrong-Horse-9-Battery-Staple' } })
        expect(wrong.status).toBe(401)

        const me = await call('/auth/me', { headers: { authorization: `Bearer ${accessToken}` } })
        expect(me).toMatchObject({ status: 200, body: { email: credentials.email } })

        const refreshed = await call('/auth/refresh', { method: 'POST', body: { refreshToken } })
        expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200)
        expect(typeof refreshed.body['accessToken']).toBe('string')
      } finally {
        // SIGTERM → app.shutdown() → process.exit(0): a clean shutdown.
        expect(await server.stop(), server.log()).toBe(0)
      }
    }, 120_000)

    it('development: db:migrate creates the database, then creates AND applies each migration; db:generate and db:seed follow', async () => {
      rmSync(devDir, { recursive: true, force: true })
      mkdirSync(devDir, { recursive: true })
      await createProject({ name, dir: devDir, prisma: true })
      const devUrl = urlOf(devDatabase)
      const env = await read(devDir, '.env')
      await write(devDir, '.env', env.replace(new RegExp(`^${urlKey}=.*$`, 'm'), `${urlKey}=${devUrl}`))
      const applied = () =>
        queryAt<{ migration_name: string; finished: boolean }>(
          devUrl,
          'SELECT migration_name, finished_at IS NOT NULL AS finished FROM _prisma_migrations ORDER BY started_at',
        )
      const migrationsOnDisk = () => readdirSync(join(devDir, 'prisma', 'migrations')).filter((entry) => /^\d+_/.test(entry)).sort()

      // First run, as the README says (`pnpm db:migrate`), named so nothing prompts.
      const first = runScript(devDir, 'db:migrate', ['--name', 'init'])
      expect(first).toContain(`PostgreSQL database ${devDatabase} created`)
      expect(migrationsOnDisk()).toHaveLength(1)
      expect(migrationsOnDisk()[0]).toMatch(/_init$/)
      expect(await applied()).toEqual([{ migration_name: migrationsOnDisk()[0], finished: true }])
      expect(await queryAt(devUrl, `SELECT to_regclass('public.tenants')::text AS t`)).toEqual([{ t: 'tenants' }])

      // The everyday run with nothing to do: no name needed, nothing prompts.
      expect(runScript(devDir, 'db:migrate')).toContain('Already in sync')
      expect(migrationsOnDisk()).toHaveLength(1)

      // A schema change: one command writes the migration and applies it.
      const schemaPath = join(devDir, 'prisma', 'schema.prisma')
      const schema = readFileSync(schemaPath, 'utf8')
      await write(devDir, 'prisma/schema.prisma', `${schema}\nmodel Note {\n  id   String @id\n  body String\n\n  @@map("notes")\n}\n`)
      runScript(devDir, 'db:migrate', ['--name', 'add_note'])
      const onDisk = migrationsOnDisk()
      expect(onDisk).toHaveLength(2)
      expect(onDisk[1]).toMatch(/_add_note$/)
      expect(readFileSync(join(devDir, 'prisma', 'migrations', onDisk[1]!, 'migration.sql'), 'utf8')).toContain('CREATE TABLE "notes"')
      expect(await applied()).toEqual(onDisk.map((migration_name) => ({ migration_name, finished: true })))
      expect(await queryAt(devUrl, `SELECT to_regclass('public.notes')::text AS t`)).toEqual([{ t: 'notes' }])
      expect(prismaIn(devDir, ['migrate', 'status'])).toContain('Database schema is up to date')

      // Prisma 7's `migrate dev` neither generates the client nor seeds: the
      // scaffold's docs list db:generate (also run on install) and db:seed as
      // their own steps. If this starts failing, Prisma changed — update them.
      expect(existsSync(join(devDir, 'generated', 'prisma'))).toBe(false)
      expect(await queryAt(devUrl, 'SELECT id FROM tenants')).toEqual([])
      runScript(devDir, 'db:generate')
      expect(readFileSync(join(devDir, 'generated', 'prisma', 'index.d.ts'), 'utf8')).toContain('export type Note =')
      runScript(devDir, 'db:seed')
      expect(await queryAt(devUrl, 'SELECT id FROM tenants')).toEqual([{ id: 'demo' }])
    }, 300_000)
  },
)
