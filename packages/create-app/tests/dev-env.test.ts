import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject, generateAppSecret } from '../src/index.js'
import { INSECURE_SECRET } from '../src/project/doctor.js'
import { read, write } from './helpers/project.js'

// Connection URLs with credentials are assembled at runtime so secret scanners
// don't read these fake test credentials as real ones.
const pgUrl = (user: string, password: string, rest: string): string => ['postgres://', user, ':', password, '@', rest].join('')

/**
 * The generated dev entrypoints, executed for real (Node's type stripping, no
 * install): the app and the dev tools are replaced by stubs that print what
 * they saw, so what is under test is exactly the template code that runs
 * BEFORE the app — .env loading, the pre-boot `upgrade`, the env error.
 */

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'basalt-dev-env-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A scaffold whose dev tools (@basaltkit/cli, generator, prisma) are stubs. */
async function scaffold(name: string): Promise<string> {
  const dir = join(root, name)
  await createProject({ name, dir, prisma: true, cli: true })
  const stub = async (pkg: string, source: string): Promise<void> => {
    await write(dir, `node_modules/${pkg}/package.json`, JSON.stringify({ name: pkg, type: 'module', main: 'index.js' }))
    await write(dir, `node_modules/${pkg}/index.js`, source)
  }
  await stub(
    '@basaltkit/cli',
    `export const consoleIo = () => ({ log: console.log, error: console.error })
export const parseArgv = (argv) => ({ command: argv[0], args: [], flags: Object.fromEntries(argv.slice(1).map((f) => [f.replace(/^--/, ''), true])) })
export const upgradeCommand = { handle: ({ io, flags }) => { io.log('UPGRADE ' + JSON.stringify(flags)); return 0 } }
export const runCli = async ({ app }) => { console.log('RUNCLI ' + JSON.stringify(app)); return 0 }
`,
  )
  await stub('@basaltkit/generator', 'export const generatorCommands = () => []\n')
  await stub('@basaltkit/prisma', 'export const prismaSyncCommand = () => ({})\n')
  return dir
}

/** The app as bin/basalt.ts and src/dev.ts import it: prints the env it booted with. */
const PRINTING_APP = `const seen = { url: process.env.DEVENV_DATABASE_URL, port: process.env.DEVENV_PORT, nodeEnv: process.env.NODE_ENV }
export const buildApp = () => seen
`

function run(dir: string, file: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', file, ...args], {
    cwd: dir,
    encoding: 'utf8',
    // A clean environment: only what the test exports (plus PATH for Node).
    env: { PATH: process.env['PATH'] ?? '', ...env },
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('generated .env for development', () => {
  it('createProject writes a git-ignored .env with local values and a strong generated secret', async () => {
    const dir = join(root, 'fresh')
    const result = await createProject({ name: 'fresh', dir, prisma: true })
    expect(result.files).toContain('.env')
    const env = await read(dir, '.env')
    expect(env).toContain(`FRESH_DATABASE_URL=${pgUrl('postgres', 'postgres', 'localhost:5432/fresh')}\n`)
    const secret = /^FRESH_APP_SECRET=(.+)$/m.exec(env)?.[1] ?? ''
    expect(secret.length).toBeGreaterThanOrEqual(32)
    expect(INSECURE_SECRET.test(secret)).toBe(false)
    expect(await read(dir, '.gitignore')).toMatch(/^\.env$/m)
    // Every scaffold gets its own secret.
    const other = join(root, 'other')
    await createProject({ name: 'fresh', dir: other })
    expect(/^FRESH_APP_SECRET=(.+)$/m.exec(await read(other, '.env'))?.[1]).not.toBe(secret)
  })

  it('generateAppSecret redraws a value secret() would reject as a placeholder', () => {
    const draws = [Buffer.from('test'.repeat(16), 'base64url'), Buffer.alloc(48, 7)]
    const secret = generateAppSecret(() => draws.shift() as Buffer)
    expect(secret).toBe(Buffer.alloc(48, 7).toString('base64url'))
  })
})

describe('bin/basalt.ts — before the app boots', () => {
  it('loads .env without overriding exported variables', async () => {
    const dir = await scaffold('devenv')
    await write(dir, 'src/app.js', PRINTING_APP)
    await write(dir, '.env', 'DEVENV_DATABASE_URL=postgres://from-dotenv/devenv\nDEVENV_PORT=3000\n')
    const { code, stdout, stderr } = run(dir, 'bin/basalt.ts', ['list'], { DEVENV_PORT: '4000' })
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(JSON.parse(stdout.replace(/^RUNCLI /, ''))).toEqual({
      url: 'postgres://from-dotenv/devenv',
      port: '4000',
      nodeEnv: 'development',
    })
  })

  it('makes the scaffolded .env visible to the app as generated', async () => {
    const dir = await scaffold('devenv')
    await write(dir, 'src/app.js', PRINTING_APP)
    const { stdout } = run(dir, 'bin/basalt.ts', ['list'])
    expect(JSON.parse(stdout.replace(/^RUNCLI /, '')).url).toBe(pgUrl('postgres', 'postgres', 'localhost:5432/devenv'))
  })

  it('runs `upgrade` without importing the app', async () => {
    const dir = await scaffold('upgrade')
    await write(dir, 'src/app.js', `throw new Error('the app was imported')\n`)
    const { code, stdout, stderr } = run(dir, 'bin/basalt.ts', ['upgrade', '--dry'])
    expect(stderr).toBe('')
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('UPGRADE {"dry":true}')
  })

  it('turns an env validation failure into a fix, not a stack trace', async () => {
    const dir = await scaffold('broken')
    await write(
      dir,
      'src/app.js',
      `const error = new Error('Invalid environment variables')
Object.assign(error, { code: 'ENV_INVALID', report: ['BROKEN_DATABASE_URL (or DATABASE_URL): Invalid input: expected string, received undefined'] })
throw error
`,
    )
    await rm(join(dir, '.env'))
    const { code, stdout, stderr } = run(dir, 'bin/basalt.ts', ['list'])
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('The app cannot start — invalid environment variables:')
    expect(stderr).toContain('  - BROKEN_DATABASE_URL (or DATABASE_URL): Invalid input')
    expect(stderr).toMatch(/your shell's environment only — there is no \S*\/broken\/\.env\./)
    expect(stderr).toContain('Fix: cp .env.example .env, then fill them in (or export them) — for DATABASE_URL, start PostgreSQL')
    expect(stderr).not.toMatch(/^\s+at /m)

    // With a .env, the message says it was read; BASALT_DEBUG=1 keeps the stack.
    await write(dir, '.env', 'BROKEN_PORT=3000\n')
    expect(run(dir, 'bin/basalt.ts', ['list']).stderr).toMatch(/environment and \S*\/broken\/\.env \(exported variables win\)/)
    const debug = run(dir, 'bin/basalt.ts', ['list'], { BASALT_DEBUG: '1' })
    expect(debug.code).toBe(1)
    expect(debug.stderr).toMatch(/^\s+at /m)
  })

  /** An app whose boot (inside runCli) throws `error`; src/env.ts resolved the URL from DBAPP_DATABASE_URL. */
  async function failingBoot(name: string, error: string): Promise<string> {
    const dir = await scaffold(name)
    await write(dir, 'src/app.js', 'export const buildApp = () => ({})\n')
    await write(dir, 'src/env.js', 'export const env = { DATABASE_URL: process.env.DBAPP_DATABASE_URL ?? process.env.DATABASE_URL }\n')
    await write(
      dir,
      'node_modules/@basaltkit/cli/index.js',
      (await read(dir, 'node_modules/@basaltkit/cli/index.js')).replace(
        /export const runCli = .*\n/,
        `export const runCli = async () => { ${error} }\n`,
      ),
    )
    await write(dir, '.env', `DBAPP_DATABASE_URL=${pgUrl('alice', 's3cret-pw', 'db.local:5433/dbapp')}\n`)
    return dir
  }

  it('explains a database that does not answer — host:port, never the credentials', async () => {
    const dir = await failingBoot(
      'refused',
      `throw Object.assign(new AggregateError([Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), { code: 'ECONNREFUSED' })], ''), { code: 'ECONNREFUSED' })`,
    )
    const { code, stdout, stderr } = run(dir, 'bin/basalt.ts', ['routes'])
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('The app cannot start — the database did not answer.')
    expect(stderr).toContain('Database: postgres://db.local:5433/dbapp (from DBAPP_DATABASE_URL; credentials never shown).')
    expect(stderr).toContain('Fix: start PostgreSQL (e.g. `docker compose up -d`')
    expect(stderr).toContain('check that DBAPP_DATABASE_URL in .env points at it')
    expect(stderr).toContain('`pnpm db:migrate`')
    expect(stderr).not.toMatch(/alice|s3cret/)
    expect(stderr).not.toMatch(/^\s+at /m)
    // The exported bare name is reported when that is what the app used.
    const bare = run(dir, 'bin/basalt.ts', ['routes'], { DATABASE_URL: pgUrl('bob', 'pw', 'other:5432/x') })
    expect(bare.stderr).toContain('Database: postgres://db.local:5433/dbapp (from DBAPP_DATABASE_URL')
    const debug = run(dir, 'bin/basalt.ts', ['routes'], { BASALT_DEBUG: '1' })
    expect(debug.code).toBe(1)
    expect(debug.stderr).toMatch(/^\s+at /m)
  })

  it('treats Prisma P1001 and an assertMigrated that could not query as an unreachable database', async () => {
    for (const [name, error] of [
      ['p1001', `throw Object.assign(new Error("Can't reach database server at db.local:5433"), { code: 'P1001' })`],
      ['unverified', `throw Object.assign(new Error('Could not verify that the configured database is migrated (assertMigrated): \\nInvalid invocation'), { code: 'PRISMA_NOT_MIGRATED' })`],
    ] as const) {
      const { code, stderr } = run(await failingBoot(name, error), 'bin/basalt.ts', ['routes'])
      expect(code, name).toBe(1)
      expect(stderr, name).toContain('The app cannot start — the database did not answer.')
    }
  })

  it('explains an unmigrated database', async () => {
    const dir = await failingBoot(
      'unmigrated',
      `throw Object.assign(new Error('Database "dbapp" on db.local:5433 has no _prisma_migrations table — it was never migrated'), { code: 'PRISMA_NOT_MIGRATED' })`,
    )
    const { code, stderr } = run(dir, 'bin/basalt.ts', ['routes'])
    expect(code).toBe(1)
    expect(stderr).toContain('The app cannot start — the database is not migrated:')
    expect(stderr).toContain('has no _prisma_migrations table')
    expect(stderr).toContain('Database: postgres://db.local:5433/dbapp (from DBAPP_DATABASE_URL')
    expect(stderr).toContain('Fix: run `pnpm db:migrate` (development; `pnpm db:deploy` in production)')
    expect(stderr).not.toMatch(/alice|s3cret|^\s+at /m)
  })

  it('leaves other boot errors alone', async () => {
    const dir = await scaffold('other')
    await write(dir, 'src/app.js', `throw new Error('database unreachable')\n`)
    const { code, stderr } = run(dir, 'bin/basalt.ts', ['list'])
    expect(code).toBe(1)
    expect(stderr).toContain('database unreachable')
    expect(stderr).not.toContain('invalid environment variables')
  })
})

describe('src/dev.ts', () => {
  it('loads .env without overriding exported variables; server.ts alone loads nothing', async () => {
    const dir = await scaffold('devts')
    const printer = `console.log(JSON.stringify({ url: process.env.DEVTS_DATABASE_URL ?? null, port: process.env.DEVTS_PORT ?? null, nodeEnv: process.env.NODE_ENV ?? null }))\n`
    await write(dir, 'src/server.js', printer)
    await write(dir, '.env', 'DEVTS_DATABASE_URL=postgres://from-dotenv/devts\nDEVTS_PORT=3000\nNODE_ENV=development\n')
    const dev = run(dir, 'src/dev.ts', [], { DEVTS_PORT: '4000' })
    expect(dev.stderr).toBe('')
    expect(JSON.parse(dev.stdout)).toEqual({ url: 'postgres://from-dotenv/devts', port: '4000', nodeEnv: 'development' })
    // `pnpm start` runs server.ts directly: production configuration comes from the environment only.
    expect(await read(dir, 'src/server.ts')).not.toMatch(/loadEnvFile|\.env/)
    expect(JSON.parse(await read(dir, 'package.json')).scripts.start).toBe('tsx src/server.ts')
  })

  it('still starts without a .env', async () => {
    const dir = await scaffold('nodotenv')
    await write(dir, 'src/server.js', `console.log(process.env.NODE_ENV)\n`)
    await rm(join(dir, '.env'))
    const dev = run(dir, 'src/dev.ts', [])
    expect(dev.stderr).toBe('')
    expect(dev.stdout.trim()).toBe('development')
  })
})
