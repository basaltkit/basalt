import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject } from '../src/index.js'
import { loadProject } from '../src/project/context.js'
import { envPrefixOf, parseDotenv, requiredEnvKeys, runDoctor } from '../src/project/doctor.js'
import { runProjectCommand } from '../src/project/run.js'
import { fakeRegistry, harness, install, read, write } from './helpers/project.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'basalt-doctor-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A scaffolded app whose node_modules holds every declared dependency at its range floor. */
async function installedApp(name: string, options: Partial<Omit<Parameters<typeof createProject>[0], 'name' | 'dir'>> = {}) {
  const dir = join(root, name)
  await createProject({ name, dir, ...options })
  await write(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n')
  const pkg = JSON.parse(await read(dir, 'package.json'))
  for (const [dep, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>)) {
    await install(dir, dep, range.replace(/^[\^~]/, ''))
  }
  return dir
}

const doctor = async (dir: string, args: string[] = [], options: Parameters<typeof harness>[1] = {}) => {
  const h = harness(dir, options)
  const code = await runProjectCommand(['doctor', '--offline', ...args], h.deps)
  return { code, out: h.output() }
}

describe('doctor', () => {
  it('passes (exit 0) on a healthy installed app — warnings only', async () => {
    const dir = await installedApp('healthy')
    let { code, out } = await doctor(dir)
    expect(code).toBe(0)
    expect(out).toContain('✓ node')
    expect(out).toContain('Installed dependencies match package.json')
    // The scaffold's .env carries a generated secret that passes the checks.
    expect(out).toMatch(/✓ env\s+HEALTHY_APP_SECRET is set \(\.env HEALTHY_APP_SECRET, 64 characters\)/)
    expect(out).not.toContain('No .env')
    expect(out).toMatch(/No errors|All checks passed/)

    // No .env and no secret: warnings (dev works with its defaults), never an error.
    await rm(join(dir, '.env'))
    ;({ code, out } = await doctor(dir))
    expect(code).toBe(0)
    expect(out).toMatch(/! env\s+No \.env — `dev` and `basalt` load it for development: `cp \.env\.example \.env`/)
    expect(out).toMatch(/! env\s+HEALTHY_APP_SECRET is not set/)
    expect(out).toContain('No errors')
  })

  it('errors (exit 1) when dependencies are not installed', async () => {
    const dir = join(root, 'bare')
    await createProject({ name: 'bare', dir })
    const { code, out } = await doctor(dir)
    expect(code).toBe(1)
    expect(out).toContain('Dependencies are not installed — run `npm install`')
    expect(out).toContain('No lockfile')
  })

  it('errors on an unsupported Node version', async () => {
    const dir = await installedApp('old-node')
    const { code, out } = await doctor(dir, [], { nodeVersion: '20.11.0' })
    expect(code).toBe(1)
    expect(out).toContain('Node 20.11.0 does not satisfy >=22.5.0')
  })

  it('checks the auth secret length against src/env.ts, from the environment or .env', async () => {
    const dir = await installedApp('secrets')
    await write(dir, '.env', 'SECRETS_APP_SECRET=too-short\n')
    let result = await doctor(dir)
    expect(result.code).toBe(1)
    expect(result.out).toMatch(/SECRETS_APP_SECRET \(\.env SECRETS_APP_SECRET\) is 9 characters — the app requires at least 32/)

    await write(dir, '.env', `SECRETS_APP_SECRET=${'k9'.repeat(24)}\n`)
    result = await doctor(dir)
    expect(result.code).toBe(0)
    expect(result.out).toContain('SECRETS_APP_SECRET is set (.env SECRETS_APP_SECRET, 48 characters)')

    // The environment wins over .env, and placeholders are rejected like secret() does.
    result = await doctor(dir, [], { env: { NO_COLOR: '1', SECRETS_APP_SECRET: 'change-me-change-me-change-me-change-me' } })
    expect(result.code).toBe(1)
    expect(result.out).toContain('looks like a placeholder')
  })

  it('flags duplicated framework versions and unmet peer ranges', async () => {
    const dir = await installedApp('peers')
    const pkg = JSON.parse(await read(dir, 'package.json'))
    const core = pkg.dependencies['@basaltkit/core'].slice(1)
    await install(dir, '@basaltkit/tenancy', pkg.dependencies['@basaltkit/tenancy'].slice(1), {
      peerDependencies: { '@basaltkit/core': '^99.0.0' },
    })
    await write(dir, 'node_modules/.pnpm/@basaltkit+core@0.9.0/x', '')
    const { code, out } = await doctor(dir)
    expect(code).toBe(1)
    expect(out).toContain(`@basaltkit/tenancy expects @basaltkit/core ^99.0.0, but ${core} is installed`)
    expect(out).toMatch(/@basaltkit\/core is installed in 2 versions \(0\.9\.0, /)
  })

  it('flags installed versions out of sync with package.json', async () => {
    const dir = await installedApp('drift')
    await install(dir, 'zod', '3.22.0')
    const { code, out } = await doctor(dir)
    expect(code).toBe(1)
    expect(out).toMatch(/zod \(3\.22\.0 installed, \^4\.\S+ declared\)/)
  })

  it('reports framework packages behind latest (registry)', async () => {
    const dir = await installedApp('behind')
    const h = harness(dir, { fetch: fakeRegistry({ '@basaltkit/core': { version: '9.0.0' } }) })
    expect(await runProjectCommand(['doctor'], h.deps)).toBe(0)
    expect(h.output()).toMatch(/framework package\(s\) behind latest: @basaltkit\/core \^\S+ → 9\.0\.0/)
  })

  it('checks .mcp.json when the ai-mcp bridge is installed', async () => {
    const dir = await installedApp('mcp', { mcp: true })
    expect((await doctor(dir)).out).toContain('.mcp.json registers the basalt-ai-mcp dev bridge')
    await write(dir, '.mcp.json', '{ nope')
    const broken = await doctor(dir)
    expect(broken.code).toBe(1)
    expect(broken.out).toContain('.mcp.json is not valid JSON')
    await write(dir, '.mcp.json', '{"mcpServers":{"other":{"command":"node","args":["x.js"]}}}')
    expect((await doctor(dir)).out).toContain('.mcp.json has no server running @basaltkit/ai-mcp')
  })

  it('checks the Prisma client and migrations', async () => {
    const dir = await installedApp('db', { prisma: true })
    let result = await doctor(dir, [], { env: { NO_COLOR: '1', DB_DATABASE_URL: 'postgres://x' } })
    expect(result.code).toBe(1)
    expect(result.out).toContain('Prisma client not generated (generated/prisma)')
    expect(result.out).toContain('No migrations yet')
    expect(result.out).toContain('DB_DATABASE_URL is set ($DB_DATABASE_URL)')
    await write(dir, 'generated/prisma/client.ts', '')
    await write(dir, 'prisma/migrations/20260101000000_init/migration.sql', '')
    // The scaffold's .env provides the URL…
    result = await doctor(dir, [], { env: { NO_COLOR: '1' } })
    expect(result.code).toBe(0)
    expect(result.out).toContain('1 migration(s) on disk')
    expect(result.out).toContain('DB_DATABASE_URL is set (.env DB_DATABASE_URL)')
    // …and without it, a required variable missing everywhere is an error with the fix.
    await rm(join(dir, '.env'))
    result = await doctor(dir, [], { env: { NO_COLOR: '1' } })
    expect(result.code).toBe(1)
    expect(result.out).toContain(
      'DB_DATABASE_URL is not set (environment or .env) — the app does not boot without it. Fix: `cp .env.example .env`, or export it — and start PostgreSQL where it points.',
    )
    await write(dir, '.env', 'DB_PORT=3000\n')
    result = await doctor(dir, [], { env: { NO_COLOR: '1' } })
    expect(result.out).toContain('Fix: set DB_DATABASE_URL in .env (.env.example has an example value), or export it')
  })

  it('warns about dev tooling declared as a runtime dependency', async () => {
    const dir = await installedApp('devtools')
    const ctx = await loadProject(dir)
    ctx.packageJson.dependencies = { ...ctx.packageJson.dependencies, '@basaltkit/ai-mcp': '^0.3.0' }
    const findings = await runDoctor(ctx, { offline: true, env: {}, nodeVersion: '24.0.0' })
    expect(findings.some((f) => f.level === 'warn' && f.message.startsWith('@basaltkit/ai-mcp is a runtime dependency'))).toBe(true)
  })

  it('helpers: dotenv parsing and the env prefix', () => {
    expect(parseDotenv('# c\nA=1\nexport B="two"\nC=\'3\'\n bad line\n')).toEqual({ A: '1', B: 'two', C: '3' })
    expect(envPrefixOf("defineEnv({}, { prefix: 'MY_APP' })", 'x')).toBe('MY_APP')
    expect(envPrefixOf("defineEnv({}, { prefix: { value: 'P', fallback: false } })", 'x')).toBe('P')
    expect(envPrefixOf('defineEnv({})', 'x')).toBe('')
    expect(envPrefixOf(undefined, 'my-saas')).toBe('MY_SAAS')
  })

  it('helpers: the required variables of src/env.ts', async () => {
    const dir = join(root, 'schema')
    await createProject({ name: 'schema', dir, prisma: true })
    // Defaults (PORT, HOST, LOG_LEVEL, NODE_ENV) and secret() are not "required".
    expect(requiredEnvKeys(await read(dir, 'src/env.ts'))).toEqual(['DATABASE_URL'])
    expect(
      requiredEnvKeys(`defineEnv({
  // a comment: with { braces }
  A: z.string(),
  /* B: z.string(), */ C: z.string().optional(),
  D: z.object({ E: z.string() }),
  F: z.string().url(), G: z.string().default('x, y'),
  H: z.string().nullish(),
}, { prefix: 'P' })`),
    ).toEqual(['A', 'D', 'F'])
    expect(requiredEnvKeys(undefined)).toBeUndefined()
    // Linear on hostile comment runs (was a backtracking regex — CodeQL js/redos).
    const started = performance.now()
    expect(requiredEnvKeys(`defineEnv({${'/*' + '*//*'.repeat(50_000)} A: z.string() })`)).toEqual([])
    expect(performance.now() - started).toBeLessThan(2000)
    expect(requiredEnvKeys('export const env = process.env')).toBeUndefined()
  })

  it('flags a required variable of a custom schema, and old dev entrypoints', async () => {
    const dir = await installedApp('custom-env', { cli: true })
    const envTs = (await read(dir, 'src/env.ts')).replace('PORT: z.coerce', 'REDIS_URL: z.string().url(),\n    PORT: z.coerce')
    await write(dir, 'src/env.ts', envTs)
    let result = await doctor(dir)
    expect(result.code).toBe(1)
    expect(result.out).toContain('CUSTOM_ENV_REDIS_URL is not set (environment or .env) — the app does not boot without it. Fix: set CUSTOM_ENV_REDIS_URL in .env, or export it.')
    result = await doctor(dir, [], { env: { NO_COLOR: '1', REDIS_URL: 'redis://x' } })
    expect(result.out).toContain('CUSTOM_ENV_REDIS_URL is set ($REDIS_URL)')

    // A 1.10 bin/basalt.ts and src/dev.ts: patchable, said so.
    const fixture = (path: string) => readFile(join(import.meta.dirname, 'fixtures', path), 'utf8')
    await write(dir, 'bin/basalt.ts', await fixture('legacy-bins/2026-10-01.ts.txt'))
    await write(dir, 'src/dev.ts', await fixture('legacy-dev/2026-09-19.ts.txt'))
    result = await doctor(dir, [], { env: { NO_COLOR: '1', REDIS_URL: 'redis://x' } })
    expect(result.out).toContain('bin/basalt.ts is an older template (no .env loading / pre-boot project commands)')
    expect(result.out).toContain('src/dev.ts does not load .env (older template)')
    await write(dir, 'src/dev.ts', '// mine\n')
    result = await doctor(dir, [], { env: { NO_COLOR: '1', REDIS_URL: 'redis://x' } })
    expect(result.out).toContain('src/dev.ts is customised and does not load .env')
  })
})

describe('info', () => {
  it('prints a paste-able versions summary', async () => {
    const dir = await installedApp('infoapp', { ui: true })
    const h = harness(dir)
    expect(await runProjectCommand(['info'], h.deps)).toBe(0)
    const out = h.output()
    expect(out).toMatch(/^create-basalt\s+\d+\.\d+\.\d+/m)
    expect(out).toContain('pm             pnpm 11.8.0 (lockfile)')
    expect(out).toContain('features       tenancy, auth, ui')
    expect(out).toMatch(/@basaltkit\/core\s+\^\S+\s+\d+\.\d+\.\d+/)
    expect(out).toMatch(/web: react\s+\^19/)
  })
})
