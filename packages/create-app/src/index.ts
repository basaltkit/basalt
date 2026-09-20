import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  appTest,
  appTs,
  dbTs,
  devTs,
  dockerignore,
  envExample,
  envTs,
  gitignore,
  mcpJson,
  basaltBin,
  packageJson,
  pnpmWorkspaceYaml,
  prismaConfigTs,
  prismaSchema,
  prismaSeedTs,
  readme,
  routesTs,
  serverTs,
  tsconfigJson,
  type ProjectOptions,
} from './templates.js'
import { uiFiles } from './templates-ui.js'
import {
  applyVersions,
  collectDependencies,
  resolveLatestVersions,
  type ResolveLatestOptions,
  type VersionResolution,
} from './latest-versions.js'

export type { ProjectOptions } from './templates.js'

export interface CreateProjectInput {
  name: string
  /** Target directory. Default: ./<name> under cwd. */
  dir?: string
  tenancy?: boolean
  auth?: boolean
  billing?: boolean
  /** Scaffold a web/ frontend (React + shadcn + SDK). Default: false. */
  ui?: boolean
  /** Scaffold the `basalt` CLI entrypoint (code generators + commands). Default: false. */
  cli?: boolean
  /** Expose opted-in routes as MCP tools over HTTP at `/mcp`. Default: false. */
  mcp?: boolean
  /**
   * Back the app with PostgreSQL through Prisma: `prisma/schema.prisma`,
   * `src/db.ts`, `prismaPlugin({ assertMigrated: true })` and the Prisma-backed
   * stores instead of the in-memory ones. Default: false (no database at all).
   */
  prisma?: boolean
  /**
   * Resolve every dependency to its latest published version (npm registry)
   * before writing files. Default: false — the embedded fallback ranges are
   * used and no network is touched. The `create-basalt` CLI turns it on
   * (unless `--offline`). Registry failures never fail the scaffold.
   */
  resolveLatest?: boolean
  /** Registry options for `resolveLatest` (injectable fetch, registry, timeouts). */
  registry?: ResolveLatestOptions
}

export interface CreateProjectResult {
  dir: string
  files: string[]
  options: ProjectOptions
  /** How dependency versions were resolved — present only with `resolveLatest`. */
  versions?: VersionResolution
}

export class TargetNotEmptyError extends Error {
  constructor(dir: string) {
    super(`Target directory "${dir}" already exists and is not empty.`)
    this.name = 'TargetNotEmptyError'
  }
}

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

/**
 * Detects the package manager that invoked `npm create` / `npx`, via the
 * `npm_config_user_agent` env var npm/pnpm/yarn/bun all set. Falls back to npm.
 */
export function detectPackageManager(
  userAgent: string | undefined = process.env['npm_config_user_agent'],
): PackageManager {
  const name = userAgent?.split(' ')[0]?.split('/')[0]
  if (name === 'pnpm' || name === 'yarn' || name === 'bun') return name
  return 'npm'
}

/**
 * Resolve whether to install dependencies / init git when the flag was not
 * given explicitly (D1, ecosystem review 2026-08): interactive terminals
 * default to YES — `npm create basalt my-app` should end in a runnable app —
 * while CI and non-TTY runs default to NO, so automation never gets a
 * surprise install. An explicit `--install`/`--no-install` (or git flag)
 * always wins over the environment.
 */
export function resolveRunDefaults(input: {
  install?: boolean | undefined
  git?: boolean | undefined
  isTTY: boolean
  ci: boolean
}): { install: boolean; git: boolean; interactive: boolean } {
  const interactive = input.isTTY && !input.ci
  return {
    interactive,
    install: input.install ?? interactive,
    git: input.git ?? interactive,
  }
}

/** Generates a ready-to-run Basalt app. Does not install dependencies. */
export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  const options: ProjectOptions = {
    name: input.name,
    tenancy: input.tenancy ?? true,
    auth: input.auth ?? true,
    billing: input.billing ?? false,
    ui: input.ui ?? false,
    cli: input.cli ?? false,
    mcp: input.mcp ?? false,
    prisma: input.prisma ?? false,
  }
  const dir = resolve(input.dir ?? input.name)

  const existing = await readdir(dir).catch(() => null)
  if (existing && existing.length > 0) throw new TargetNotEmptyError(dir)

  const files: Record<string, string> = {
    'package.json': packageJson(options),
    'tsconfig.json': tsconfigJson(options),
    '.env.example': envExample(options),
    '.gitignore': gitignore(options),
    '.dockerignore': dockerignore(),
    'README.md': readme(options),
    'pnpm-workspace.yaml': pnpmWorkspaceYaml(options),
    'src/env.ts': envTs(options),
    'src/app.ts': appTs(options),
    'src/routes.ts': routesTs(options),
    'src/server.ts': serverTs(),
    'src/dev.ts': devTs(),
    'tests/app.test.ts': appTest(options),
    ...(options.prisma
      ? {
          'prisma/schema.prisma': prismaSchema(options),
          'prisma.config.ts': prismaConfigTs(options),
          'src/db.ts': dbTs(options),
          // The demo tenant only exists where tenancy does.
          ...(options.tenancy ? { 'prisma/seed.ts': prismaSeedTs(options) } : {}),
        }
      : {}),
    ...(options.cli ? { 'bin/basalt.ts': basaltBin() } : {}),
    ...(options.mcp ? { '.mcp.json': mcpJson(options) } : {}),
    ...(options.ui ? uiFiles(options) : {}),
  }

  let versions: VersionResolution | undefined
  if (input.resolveLatest) {
    const manifests = Object.keys(files).filter((path) => path === 'package.json' || path.endsWith('/package.json'))
    versions = await resolveLatestVersions(
      collectDependencies(manifests.map((path) => files[path] as string)),
      input.registry,
    )
    for (const path of manifests) files[path] = applyVersions(files[path] as string, versions.versions)
  }

  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }

  return { dir, files: Object.keys(files).sort(), options, ...(versions ? { versions } : {}) }
}

export {
  THIRD_PARTY_VERSIONS,
  DEFAULT_REGISTRY,
  DEFAULT_MINIMUM_RELEASE_AGE_MINUTES,
  describeResolution,
  minimumReleaseAgeMinutes,
  resolveLatestVersions,
  registryUrl,
  type FreshVersion,
  type HeldBackVersion,
  type ResolveLatestOptions,
  type VersionResolution,
} from './latest-versions.js'
export { runWizard, validateProjectName, PRESETS, FEATURES, type WizardResult, type WizardOptions, type FeatureKey } from './wizard.js'
export { ttyPrompter, scriptedPrompter, WizardCancelledError, type Prompter, type Choice } from './prompt.js'
