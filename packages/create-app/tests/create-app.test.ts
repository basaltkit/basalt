import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createProject, TargetNotEmptyError } from '../src/index.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'create-machize-'))
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
    // Machize deps must point at a real published range, never a placeholder.
    expect(pkg.dependencies['@machize/core']).toMatch(/^\^0\.\d+\.\d+$/)
    expect(pkg.dependencies['@machize/core']).not.toBe('^0.0.0')
    expect(pkg.dependencies).toHaveProperty('@machize/tenancy')
    expect(pkg.dependencies).toHaveProperty('@machize/auth')
    expect(pkg.dependencies).not.toHaveProperty('@machize/subscriptions')
    expect(pkg.devDependencies).toHaveProperty('@machize/testing')

    const app = await read(result.dir, 'src/app.ts')
    expect(app).toContain('tenancyPlugin')
    expect(app).toContain('authPlugin')
    expect(app).toContain('authRoutes()')
    expect(app).not.toContain('subscriptionsPlugin')

    const env = await read(result.dir, 'src/env.ts')
    expect(env).toContain('APP_SECRET')
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
    expect(pkg.dependencies).not.toHaveProperty('@machize/tenancy')
    expect(pkg.dependencies).not.toHaveProperty('@machize/auth')
    expect(pkg.dependencies).toHaveProperty('@machize/subscriptions')

    const app = await read(result.dir, 'src/app.ts')
    expect(app).not.toContain('tenancyPlugin')
    expect(app).not.toContain('authPlugin')
    expect(app).toContain('subscriptionsPlugin')
    expect(app).toContain("fallbackPlan: 'free'")

    const env = await read(result.dir, 'src/env.ts')
    expect(env).not.toContain('APP_SECRET')
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

  it('generated test file matches the chosen features', async () => {
    const withTenancy = await createProject({ name: 'a', dir: join(root, 'a') })
    expect(await read(withTenancy.dir, 'tests/app.test.ts')).toContain("'x-tenant-id': 'demo'")

    const without = await createProject({ name: 'b', dir: join(root, 'b'), tenancy: false })
    expect(await read(without.dir, 'tests/app.test.ts')).not.toContain('x-tenant-id')
  })
})
