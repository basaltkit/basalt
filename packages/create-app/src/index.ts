import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  appTest,
  appTs,
  envExample,
  envTs,
  gitignore,
  packageJson,
  pnpmWorkspaceYaml,
  readme,
  routesTs,
  serverTs,
  tsconfigJson,
  type ProjectOptions,
} from './templates.js'

export type { ProjectOptions } from './templates.js'

export interface CreateProjectInput {
  name: string
  /** Target directory. Default: ./<name> under cwd. */
  dir?: string
  tenancy?: boolean
  auth?: boolean
  billing?: boolean
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

/** Generates a ready-to-run Machize app. Does not install dependencies. */
export async function createProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  const options: ProjectOptions = {
    name: input.name,
    tenancy: input.tenancy ?? true,
    auth: input.auth ?? true,
    billing: input.billing ?? false,
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
    'pnpm-workspace.yaml': pnpmWorkspaceYaml(),
    'src/env.ts': envTs(options),
    'src/app.ts': appTs(options),
    'src/routes.ts': routesTs(options),
    'src/server.ts': serverTs(),
    'tests/app.test.ts': appTest(options),
  }

  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }

  return { dir, files: Object.keys(files).sort(), options }
}
