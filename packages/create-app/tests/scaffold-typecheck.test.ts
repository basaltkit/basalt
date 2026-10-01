import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { createProject } from '../src/index.js'
import { runProjectCommand } from '../src/project/run.js'
import { harness } from './helpers/project.js'

/**
 * The scaffold-drift net (review 2026-08-b, finding D-1): a pristine scaffold
 * MUST pass its own `pnpm typecheck`. The generated app is compiled with the
 * real tsc against the real workspace packages (declared as devDependencies of
 * create-app precisely so template ↔ package type drift fails HERE, in CI,
 * instead of in a user's first `pnpm typecheck`). D-1 itself — the template
 * emitting `LOG_LEVEL: z.string()` against loggerPlugin's LogLevel union —
 * would fail this test.
 *
 * Scaffolds live UNDER packages/create-app (gitignored) so Node module
 * resolution walks up into create-app's node_modules. Cost: one tsc run per
 * variant (~2s each).
 */

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')
const root = join(packageDir, '.scaffold-typecheck')

const typecheck = (dir: string): string => {
  try {
    execFileSync('pnpm', ['exec', 'tsc', '-p', dir], { cwd: packageDir, encoding: 'utf8', stdio: 'pipe' })
    return ''
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

/** Typechecks src + tests AND bin/ (the app's own tsconfig leaves bin/ out — tsx runs it). */
const typecheckWithBin = (dir: string): string => {
  writeFileSync(join(dir, 'tsconfig.check.json'), JSON.stringify({ extends: './tsconfig.json', include: ['src', 'tests', 'bin'] }))
  return typecheck(join(dir, 'tsconfig.check.json'))
}

/** `create-basalt add <feature>` on an existing scaffold — offline, no install. */
const addFeature = async (dir: string, feature: string): Promise<number> =>
  runProjectCommand(['add', feature, '--yes', '--offline', '--no-install', '--pm=pnpm'], harness(dir).deps)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scaffolded apps typecheck out of the box', () => {
  it('default preset (auth + tenancy)', async () => {
    const dir = join(root, 'default')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    await createProject({ name: 'scaffold-default', dir })
    expect(typecheck(dir)).toBe('')
  }, 60_000)

  it('full preset (billing + cli + mcp)', async () => {
    const dir = join(root, 'full')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    await createProject({ name: 'scaffold-full', dir, billing: true, cli: true, mcp: true })
    expect(typecheckWithBin(dir)).toBe('')
  }, 60_000)
})

describe('features added later typecheck like features scaffolded up front', () => {
  it('add ui: equivalent to --ui (same tree, see project-add.test.ts) and the API still typechecks', async () => {
    const dir = join(root, 'add-ui')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    await createProject({ name: 'scaffold-add-ui', dir })
    expect(await addFeature(dir, 'ui')).toBe(0)
    expect(existsSync(join(dir, 'web', 'src', 'App.tsx'))).toBe(true)
    const withUi = join(root, 'with-ui')
    rmSync(withUi, { recursive: true, force: true })
    mkdirSync(withUi, { recursive: true })
    await createProject({ name: 'scaffold-add-ui', dir: withUi, ui: true })
    expect(typecheck(dir)).toBe(typecheck(withUi))
    expect(typecheck(dir)).toBe('')
  }, 60_000)

  it('add cli + add mcp on a default scaffold (bin/basalt.ts included)', async () => {
    const dir = join(root, 'add-cli-mcp')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    await createProject({ name: 'scaffold-add-cli', dir })
    expect(await addFeature(dir, 'cli')).toBe(0)
    expect(await addFeature(dir, 'mcp')).toBe(0)
    expect(typecheckWithBin(dir)).toBe('')
  }, 60_000)
})

/**
 * The `--prisma` variant needs more than the templates: the generated `src/db.ts`
 * imports the client `prisma generate` writes, and the app imports the
 * `@basaltkit/*-prisma` store packages. create-app does not declare those, so in
 * an environment without them the suite SKIPS with a reason instead of
 * pretending to have checked (and instead of failing on a missing module).
 */
const prismaToolchain = (): string | undefined => {
  const require_ = createRequire(pathToFileURL(join(packageDir, 'noop.js')))
  /** Installed for create-app? (An ESM-only package resolves but has no CJS entry.) */
  const present = (pkg: string): boolean => {
    if (existsSync(join(packageDir, 'node_modules', ...pkg.split('/')))) return true
    try {
      require_.resolve(pkg)
      return true
    } catch (error) {
      return (error as { code?: string }).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    }
  }
  for (const pkg of [
    '@prisma/adapter-pg',
    '@prisma/client',
    '@basaltkit/auth-prisma',
    '@basaltkit/teams-prisma',
    '@basaltkit/tenancy-prisma',
    'pg',
  ]) {
    if (!present(pkg)) return `${pkg} is not installed for create-app`
  }
  const cli = join(packageDir, 'node_modules', '.bin', 'prisma')
  return existsSync(cli) ? undefined : 'the prisma CLI is not installed for create-app'
}

const missingToolchain = prismaToolchain()

describe.skipIf(missingToolchain !== undefined)(
  // The reason travels in the name, so a skipped run says WHY it was skipped.
  `the --prisma scaffold typechecks once generated${missingToolchain ? ` [skipped: ${missingToolchain}]` : ''}`,
  () => {
    it('generates the client and compiles src/db.ts, src/app.ts and prisma/seed.ts', async () => {
      const dir = join(root, 'prisma')
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir, { recursive: true })
      await createProject({ name: 'scaffold-prisma', dir, prisma: true, billing: true, cli: true })

      // `prisma generate` needs no database — only the schema.
      execFileSync(join(packageDir, 'node_modules', '.bin', 'prisma'), ['generate'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: 'pipe',
      })
      expect(typecheck(dir)).toBe('')
    }, 120_000)
  },
)
