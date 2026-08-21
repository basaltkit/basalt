import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject, detectPackageManager, TargetNotEmptyError } from '../src/index.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'create-basalt-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const read = (dir: string, file: string) => readFile(join(dir, file), 'utf8')

describe('createProject', () => {
  it('generates the full default project (tenancy + auth, no billing)', async () => {
    const result = await createProject({ name: 'my-saas', dir: join(root, 'my-saas') })

    expect(result.files).toEqual([
      '.env.example',
      '.gitignore',
      'README.md',
      'package.json',
      'pnpm-workspace.yaml',
      'src/app.ts',
      'src/env.ts',
      'src/routes.ts',
      'src/server.ts',
      'tests/app.test.ts',
      'tsconfig.json',
    ])

    const pkg = JSON.parse(await read(result.dir, 'package.json'))
    expect(pkg.name).toBe('my-saas')
    // npm shows "name@undefined" in errors when version is missing.
    expect(pkg.version).toBe('0.1.0')
    // Basalt deps must point at a real published range, never a placeholder.
    expect(pkg.dependencies['@basaltkit/core']).toMatch(/^\^1\.\d+\.\d+$/)
    expect(pkg.dependencies['@basaltkit/core']).not.toBe('^0.0.0')
    expect(pkg.dependencies).toHaveProperty('@basaltkit/tenancy')
    expect(pkg.dependencies).toHaveProperty('@basaltkit/auth')
    expect(pkg.dependencies).not.toHaveProperty('@basaltkit/subscriptions')
    expect(pkg.devDependencies).toHaveProperty('@basaltkit/testing')
    // Regression: the @basalt range override loop once clobbered third-party
    // ranges (zod ended up as "^0.1.0", which no @basalt peer accepts).
    expect(pkg.dependencies.zod).toBe('^4.0.0')

    const app = await read(result.dir, 'src/app.ts')
    expect(app).toContain('tenancyPlugin')
    expect(app).toContain('authPlugin')
    expect(app).toContain('authRoutes()')
    expect(app).not.toContain('subscriptionsPlugin')
    // Secure by default: the security plugin (headers on) ships in every app.
    expect(app).toContain('securityPlugin(')

    const env = await read(result.dir, 'src/env.ts')
    expect(env).toContain('APP_SECRET')
    // Fail-closed: uses the secret() helper (required in prod, no fallback),
    // never a committed default that would reach production.
    expect(env).toContain('secret({')
    expect(env).toContain('minLength: 32')
    expect(env).not.toContain('change-me-in-production')

    const envExample = await read(result.dir, '.env.example')
    expect(envExample).not.toContain('APP_SECRET=change-me')
  })

  it('honors feature flags: --billing, --no-tenancy, --no-auth', async () => {
    const result = await createProject({
      name: 'lean',
      dir: join(root, 'lean'),
      tenancy: false,
      auth: false,
      billing: true,
    })

    const pkg = JSON.parse(await read(result.dir, 'package.json'))
    expect(pkg.dependencies).not.toHaveProperty('@basaltkit/tenancy')
    expect(pkg.dependencies).not.toHaveProperty('@basaltkit/auth')
    expect(pkg.dependencies).toHaveProperty('@basaltkit/subscriptions')

    const app = await read(result.dir, 'src/app.ts')
    expect(app).not.toContain('tenancyPlugin')
    expect(app).not.toContain('authPlugin')
    expect(app).toContain('subscriptionsPlugin')
    expect(app).toContain("fallbackPlan: 'free'")

    const env = await read(result.dir, 'src/env.ts')
    expect(env).not.toContain('APP_SECRET')
  })

  it('scaffolds the web UI with --ui (workspace member + auth-aware App)', async () => {
    const result = await createProject({ name: 'withui', dir: join(root, 'withui'), ui: true })

    // web files are emitted
    expect(result.files).toContain('web/package.json')
    expect(result.files).toContain('web/src/App.tsx')
    expect(result.files).toContain('web/vite.config.ts')

    // web is a pnpm workspace member so its deps resolve
    expect(await read(result.dir, 'pnpm-workspace.yaml')).toContain('- web')

    // the web package depends on the SDK + shadcn components
    const webPkg = JSON.parse(await read(result.dir, 'web/package.json'))
    expect(webPkg.name).toBe('withui-web')
    expect(webPkg.dependencies).toHaveProperty('@basaltkit/sdk')
    expect(webPkg.dependencies).toHaveProperty('@basaltkit/admin-shadcn')

    // with auth, the App ships a login/register gate + the api exposes auth endpoints
    const app = await read(result.dir, 'web/src/App.tsx')
    expect(app).toContain('AuthScreen')
    expect(await read(result.dir, 'web/src/api.ts')).toContain("path: '/auth/login'")

    // without auth, it degrades to a status-only page (no auth endpoints)
    const noAuth = await createProject({
      name: 'statusui',
      dir: join(root, 'statusui'),
      auth: false,
      ui: true,
    })
    expect(await read(noAuth.dir, 'web/src/App.tsx')).not.toContain('AuthScreen')
    expect(await read(noAuth.dir, 'web/src/api.ts')).not.toContain('/auth/login')
  })

  it('scaffolds the basalt CLI with --cli (bin + deps + registered commands)', async () => {
    const result = await createProject({ name: 'withcli', dir: join(root, 'withcli'), cli: true })

    expect(result.files).toContain('bin/basalt.ts')

    const pkg = JSON.parse(await read(result.dir, 'package.json'))
    expect(pkg.dependencies).toHaveProperty('@basaltkit/cli')
    expect(pkg.dependencies['@basaltkit/cli']).toBe('^1.0.0')
    // The generator is a DEV tool — devDependency, not a runtime dependency.
    expect(pkg.dependencies).not.toHaveProperty('@basaltkit/generator')
    expect(pkg.devDependencies).toHaveProperty('@basaltkit/generator')
    expect(pkg.devDependencies['@basaltkit/generator']).toBe('^1.0.0')
    expect(pkg.scripts.basalt).toBe('tsx bin/basalt.ts')

    // The CLI entry (dev-only) imports the generator and passes it via `commands`.
    const bin = await read(result.dir, 'bin/basalt.ts')
    expect(bin).toContain("import { runCli } from '@basaltkit/cli'")
    expect(bin).toContain("import { generatorCommands } from '@basaltkit/generator'")
    expect(bin).toContain('commands: [...generatorCommands(), prismaSyncCommand()]')
    expect(bin).toContain('runCli({ app })')

    // The runtime app must NOT import the generator — it only wires commandsPlugin
    // conditionally from options.commands (passed by bin/basalt.ts).
    const app = await read(result.dir, 'src/app.ts')
    expect(app).not.toContain("from '@basaltkit/generator'")
    expect(app).toContain('commandsPlugin(options.commands)')
    expect(app).toContain('commands?: CommandDefinition[]')
  })

  it('omits the basalt CLI by default', async () => {
    const result = await createProject({ name: 'nocli', dir: join(root, 'nocli') })
    expect(result.files).not.toContain('bin/basalt.ts')
    const pkg = JSON.parse(await read(result.dir, 'package.json'))
    expect(pkg.dependencies).not.toHaveProperty('@basaltkit/cli')
    expect(pkg.scripts).not.toHaveProperty('basalt')
  })

  it('omits the web UI by default', async () => {
    const result = await createProject({ name: 'noui', dir: join(root, 'noui') })
    expect(result.files.some((f) => f.startsWith('web/'))).toBe(false)
    expect(await read(result.dir, 'pnpm-workspace.yaml')).not.toContain('- web')
  })

  it('detects the invoking package manager from npm_config_user_agent', () => {
    expect(detectPackageManager('pnpm/9.1.0 npm/? node/v22.0.0 darwin arm64')).toBe('pnpm')
    expect(detectPackageManager('yarn/4.1.0 npm/? node/v22.0.0')).toBe('yarn')
    expect(detectPackageManager('bun/1.1.0')).toBe('bun')
    expect(detectPackageManager('npm/10.5.0 node/v22.0.0')).toBe('npm')
    // unknown or absent agent falls back to npm
    expect(detectPackageManager('deno/1.40.0')).toBe('npm')
    expect(detectPackageManager('')).toBe('npm')
  })

  it('refuses to write into a non-empty directory', async () => {
    const dir = join(root, 'busy')
    await createProject({ name: 'busy', dir })
    await expect(createProject({ name: 'busy', dir })).rejects.toBeInstanceOf(TargetNotEmptyError)

    const other = join(root, 'other')
    await rm(other, { recursive: true, force: true })
    await writeFile(join(root, 'file.txt'), 'x')
    await expect(createProject({ name: 'x', dir: root })).rejects.toBeInstanceOf(
      TargetNotEmptyError,
    )
  })

  it('scaffolds a friendly GET / index route (no bare 404 on root)', async () => {
    const withAuth = await createProject({ name: 'rooted', dir: join(root, 'rooted') })
    const routes = await read(withAuth.dir, 'src/routes.ts')
    expect(routes).toContain("url: '/'")
    expect(routes).toContain("name: 'rooted'")
    // auth endpoints are advertised in the index when auth is on
    expect(routes).toContain("'POST /auth/login'")

    const lean = await createProject({ name: 'lean', dir: join(root, 'lean'), auth: false })
    const leanRoutes = await read(lean.dir, 'src/routes.ts')
    expect(leanRoutes).toContain("url: '/'")
    expect(leanRoutes).not.toContain('/auth/login')

    // the generated smoke test exercises the new route
    expect(await read(withAuth.dir, 'tests/app.test.ts')).toContain("url: '/'")
  })

  it('generated test file matches the chosen features', async () => {
    const withTenancy = await createProject({ name: 'a', dir: join(root, 'a') })
    expect(await read(withTenancy.dir, 'tests/app.test.ts')).toContain("'x-tenant-id': 'demo'")

    const without = await createProject({ name: 'b', dir: join(root, 'b'), tenancy: false })
    expect(await read(without.dir, 'tests/app.test.ts')).not.toContain('x-tenant-id')
  })
})
