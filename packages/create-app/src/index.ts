import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  appTest,
  appTs,
  envExample,
  envTs,
  gitignore,
  basaltBin,
  packageJson,
  pnpmWorkspaceYaml,
  readme,
  routesTs,
  serverTs,
  tsconfigJson,
  type ProjectOptions,
} from './templates.js'
import { uiFiles } from './templates-ui.js'

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
}

export interface CreateProjectResult {
  dir: string
  files: string[]
  options: ProjectOptions
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

/** Generates a ready-to-run Basalt app. Does not install dependencies. */
export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  const options: ProjectOptions = {
    name: input.name,
    tenancy: input.tenancy ?? true,
    auth: input.auth ?? true,
    billing: input.billing ?? false,
    ui: input.ui ?? false,
    cli: input.cli ?? false,
  }
  const dir = resolve(input.dir ?? input.name)

  const existing = await readdir(dir).catch(() => null)
  if (existing && existing.length > 0) throw new TargetNotEmptyError(dir)

  const files: Record<string, string> = {
    'package.json': packageJson(options),
    'tsconfig.json': tsconfigJson(),
    '.env.example': envExample(options),
    '.gitignore': gitignore(),
    'README.md': readme(options),
    'pnpm-workspace.yaml': pnpmWorkspaceYaml(options),
    'src/env.ts': envTs(options),
    'src/app.ts': appTs(options),
    'src/routes.ts': routesTs(options),
    'src/server.ts': serverTs(),
    'tests/app.test.ts': appTest(options),
    ...(options.cli ? { 'bin/basalt.ts': basaltBin() } : {}),
    ...(options.ui ? uiFiles(options) : {}),
  }

  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }

  return { dir, files: Object.keys(files).sort(), options }
}
