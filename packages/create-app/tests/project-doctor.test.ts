import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject } from '../src/index.js'
import { loadProject } from '../src/project/context.js'
import { envPrefixOf, parseDotenv, runDoctor } from '../src/project/doctor.js'
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
    const { code, out } = await doctor(dir)
    expect(code).toBe(0)
    expect(out).toContain('✓ node')
    expect(out).toContain('Installed dependencies match package.json')
    // No secret set: a warning (dev works), never an error.
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
    expect(result.out).toContain('Prisma client not generated (src/generated/prisma)')
    expect(result.out).toContain('No migrations yet')
    expect(result.out).toContain('DB_DATABASE_URL is set ($DB_DATABASE_URL)')
    await write(dir, 'src/generated/prisma/client.ts', '')
    await write(dir, 'prisma/migrations/20260101000000_init/migration.sql', '')
    result = await doctor(dir, [], { env: { NO_COLOR: '1' } })
    expect(result.code).toBe(0)
    expect(result.out).toContain('1 migration(s) on disk')
    expect(result.out).toContain('DB_DATABASE_URL is not set')
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
