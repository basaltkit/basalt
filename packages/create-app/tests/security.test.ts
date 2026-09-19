import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createProject } from '../src/index.js'
import { SCAFFOLD_VERSIONS, versionOf } from '../src/templates.js'

/**
 * Security invariants of the generated app (deep audit 2026-09, batch B13).
 *
 * Scaffolds live UNDER packages/create-app (gitignored) so the generated
 * sources resolve the real workspace @basaltkit/* packages through
 * create-app's node_modules — the behavioural tests boot the real app.
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')
const root = join(packageDir, '.scaffold-security')

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const originalNodeEnv = process.env['NODE_ENV']
afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = originalNodeEnv
})

async function scaffold(name: string, input: Record<string, unknown> = {}): Promise<string> {
  const dir = join(root, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  await createProject({ name, dir, ...input })
  return dir
}

const read = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8')

describe('scaffold: tenant membership is enforced by default (tenancy + auth)', () => {
  it('adds @basaltkit/teams and registers teamsPlugin + tenantMembershipPlugin', async () => {
    const dir = await scaffold('membership-static')
    const pkg = JSON.parse(read(dir, 'package.json'))
    expect(pkg.dependencies).toHaveProperty('@basaltkit/teams')
    const app = read(dir, 'src/app.ts')
    expect(app).toContain('teamsPlugin(')
    expect(app).toContain('tenantMembershipPlugin(')
  })

  it('does not wire membership when tenancy or auth is off (nothing to bind)', async () => {
    const noAuth = await scaffold('membership-noauth', { auth: false })
    expect(read(noAuth, 'src/app.ts')).not.toContain('tenantMembershipPlugin')
    expect(JSON.parse(read(noAuth, 'package.json')).dependencies).not.toHaveProperty('@basaltkit/teams')
    const noTenancy = await scaffold('membership-notenancy', { tenancy: false })
    expect(read(noTenancy, 'src/app.ts')).not.toContain('tenantMembershipPlugin')
  })

  it('an authenticated user cannot act on a tenant they do not belong to via x-tenant-id', async () => {
    process.env['NODE_ENV'] = 'test'
    const dir = await scaffold('membership-runtime')
    // Add a second tenant the attacker is NOT a member of.
    const appPath = join(dir, 'src/app.ts')
    const appSource = read(dir, 'src/app.ts')
    expect(appSource).toContain(".add({ id: 'demo', name: 'Demo Tenant' })")
    writeFileSync(
      appPath,
      appSource.replace(
        ".add({ id: 'demo', name: 'Demo Tenant' })",
        ".add({ id: 'demo', name: 'Demo Tenant' }).add({ id: 'victim', name: 'Victim' })",
      ),
    )

    const { buildApp } = (await import(pathToFileURL(appPath).href)) as {
      buildApp: (o: { logLevel: 'silent' }) => { boot(): Promise<any> }
    }
    const { FASTIFY } = await import('@basaltkit/fastify')
    const app = await buildApp({ logLevel: 'silent' }).boot()
    try {
      const server = app.container.get(FASTIFY)
      const credentials = { email: 'attacker@example.com', password: 'Attacker-Passw0rd!-2026' }
      const registered = await server.inject({ method: 'POST', url: '/auth/register', payload: credentials })
      expect(registered.statusCode).toBe(202)
      const login = await server.inject({ method: 'POST', url: '/auth/login', payload: credentials })
      expect(login.statusCode).toBe(200)
      const token = login.json().accessToken as string
      expect(typeof token).toBe('string')

      const victim = await server.inject({
        method: 'GET',
        url: '/',
        headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'victim' },
      })
      expect(victim.statusCode).toBe(403)

      // Variant: the subdomain resolver must be bound by the same guard.
      const viaHost = await server.inject({
        method: 'GET',
        url: '/',
        headers: { authorization: `Bearer ${token}`, host: 'victim.localhost' },
      })
      expect(viaHost.statusCode).toBe(403)

      // The dev-only demo seed lets a fresh registrant use the demo tenant.
      const demo = await server.inject({
        method: 'GET',
        url: '/',
        headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'demo' },
      })
      expect(demo.statusCode).toBe(200)

      // Account routes are about the caller, not tenant data: a non-member can
      // still read their own profile (BK-014), while tenant routes stay 403.
      const ownProfile = await server.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'victim' },
      })
      expect(ownProfile.statusCode).toBe(200)
    } finally {
      await app.shutdown()
    }
  })

  it('enables the global rate limit by default (not commented out)', async () => {
    const dir = await scaffold('ratelimit')
    const app = read(dir, 'src/app.ts')
    expect(app).toMatch(/^\s*rateLimit: \{ limit: \d+, windowMs: [\d_]+ \},/m)
    expect(app).not.toMatch(/\/\/\s*rateLimit:/)
  })
})

describe('scaffold: APP_SECRET never falls back to the public dev default outside development', () => {
  it('the start path does not opt into development; only the dev entry does', async () => {
    const dir = await scaffold('secret-scripts')
    const pkg = JSON.parse(read(dir, 'package.json'))
    expect(pkg.scripts.start).not.toMatch(/development/)
    expect(pkg.scripts.dev).toContain('src/dev.ts')
    const devEntry = read(dir, 'src/dev.ts')
    expect(devEntry).toContain("process.env['NODE_ENV'] ??= 'development'")
    // An unset NODE_ENV is treated as production by the app's own env schema too.
    expect(read(dir, 'src/env.ts')).toContain(".default('production')")
  })

  it('booting the generated env with NODE_ENV unset and no APP_SECRET fails closed', async () => {
    delete process.env['NODE_ENV']
    const dir = await scaffold('secret-runtime')
    const previous = process.env['APP_SECRET']
    delete process.env['APP_SECRET']
    try {
      await expect(import(pathToFileURL(join(dir, 'src/env.ts')).href)).rejects.toThrow(/APP_SECRET/)
    } finally {
      if (previous !== undefined) process.env['APP_SECRET'] = previous
    }
  })
})

describe('scaffold: @basaltkit/* ranges track the current release lines', () => {
  const workspaceVersions = new Map<string, string>()
  for (const entry of readdirSync(join(packageDir, '..'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(packageDir, '..', entry, 'package.json'), 'utf8'))
      if (typeof pkg.name === 'string' && typeof pkg.version === 'string') workspaceVersions.set(pkg.name, pkg.version)
    } catch {
      // not a package directory
    }
  }

  const satisfiesCaret = (range: string, version: string): boolean => {
    const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range)
    if (!match) return false
    const [maj, min, pat] = match.slice(1).map(Number) as [number, number, number]
    const [vMaj, vMin, vPat] = version.split('-')[0]!.split('.').map(Number) as [number, number, number]
    if (vMaj !== maj) return false
    if (maj === 0 && vMin !== min) return false
    if (vMin !== min) return vMin > min
    return vPat >= pat
  }

  it('every emitted @basaltkit/* range is satisfied by the workspace version (same major)', async () => {
    const dir = await scaffold('versions', { billing: true, cli: true, mcp: true, ui: true })
    const pkg = JSON.parse(read(dir, 'package.json'))
    const web = JSON.parse(read(dir, 'web/package.json'))
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...web.dependencies, ...web.devDependencies }
    const basalt = Object.entries(all).filter(([name]) => name.startsWith('@basaltkit/'))
    expect(basalt.length).toBeGreaterThan(10)
    for (const [name, range] of basalt) {
      const version = workspaceVersions.get(name)
      expect(version, `${name} exists in the workspace`).toBeDefined()
      expect(satisfiesCaret(range as string, version!), `${name}: ${String(range)} vs workspace ${version}`).toBe(true)
    }
  })

  it('the version map covers every package the templates emit, and versionOf never guesses', () => {
    for (const [name, range] of Object.entries(SCAFFOLD_VERSIONS)) {
      expect(satisfiesCaret(range, workspaceVersions.get(name) ?? '0.0.0'), `${name}: ${range}`).toBe(true)
    }
    expect(() => versionOf('@basaltkit/does-not-exist')).toThrow()
  })
})

describe('scaffold: secrets are kept out of Docker build contexts', () => {
  it('writes a .dockerignore excluding .env files, keys and VCS metadata', async () => {
    const dir = await scaffold('dockerignore')
    const ignore = read(dir, '.dockerignore')
    for (const line of ['**/.env', '**/.env.*', '!**/.env.example', '**/.git', '**/node_modules', '**/*.pem']) {
      expect(ignore.split('\n')).toContain(line)
    }
  })

  it('also excludes secrets in subdirectories (.dockerignore patterns are anchored at the context root)', async () => {
    const dir = await scaffold('dockerignore-nested')
    const ignore = read(dir, '.dockerignore')
    // prisma/.env is where Prisma conventionally reads DATABASE_URL from.
    for (const path of ['.env', 'prisma/.env', 'apps/api/.env.production', 'certs/server.key', 'config/tls/cert.pem', '.npmrc']) {
      expect(dockerIgnores(ignore, path), path).toBe(true)
    }
    for (const path of ['.env.example', 'prisma/.env.example', 'src/app.ts', 'package.json']) {
      expect(dockerIgnores(ignore, path), path).toBe(false)
    }
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
