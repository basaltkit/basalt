import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackageManager } from '../index.js'
import type { ProjectOptions } from '../templates.js'
import { readManifest, type ProjectManifest } from './manifest.js'
import type { PackageJson } from './package-json.js'

/** A Basalt app on disk, as the project commands see it. */
export interface ProjectContext {
  dir: string
  /** Raw root package.json text (edits preserve its formatting). */
  packageJsonText: string
  packageJson: PackageJson
  /** web/package.json, when the app has the frontend. */
  web?: { text: string; json: PackageJson }
  manifest?: ProjectManifest
  /** Features the app has now (manifest options, corrected by what package.json/the tree show). */
  options: ProjectOptions
  pm: PackageManager
  /** Where `pm` came from — shown by doctor/info. */
  pmSource: 'flag' | 'packageManager' | 'lockfile' | 'user-agent' | 'default'
  /** Lockfiles present in the project root. */
  lockfiles: string[]
}

export class NotABasaltAppError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotABasaltAppError'
  }
}

export const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
]

const MANAGERS: readonly PackageManager[] = ['pnpm', 'npm', 'yarn', 'bun']

/**
 * The package manager of an existing project: `--pm`, then the
 * `packageManager` field, then the lockfile, then the manager that launched us
 * (`npm_config_user_agent`), else npm. pnpm-workspace.yaml is deliberately not
 * a signal — every scaffold writes it, whatever the manager.
 */
export function detectProjectPackageManager(
  pkg: PackageJson,
  lockfiles: readonly string[],
  flag?: PackageManager,
  userAgent?: string,
): { pm: PackageManager; source: ProjectContext['pmSource'] } {
  if (flag) return { pm: flag, source: 'flag' }
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined
  if (declared && (MANAGERS as readonly string[]).includes(declared)) {
    return { pm: declared as PackageManager, source: 'packageManager' }
  }
  for (const [file, pm] of LOCKFILES) if (lockfiles.includes(file)) return { pm, source: 'lockfile' }
  const agent = userAgent?.split(' ')[0]?.split('/')[0]
  if (agent && (MANAGERS as readonly string[]).includes(agent)) return { pm: agent as PackageManager, source: 'user-agent' }
  return { pm: 'npm', source: 'default' }
}

export const allDependencies = (pkg: PackageJson): Record<string, string> => ({
  ...pkg.optionalDependencies,
  ...pkg.devDependencies,
  ...pkg.dependencies,
})

/** Whether a package.json belongs to a Basalt app (any @basaltkit/* — or legacy @machize/* — dependency). */
export const isBasaltPackage = (pkg: PackageJson): boolean =>
  Object.keys(allDependencies(pkg)).some((name) => name.startsWith('@basaltkit/') || name.startsWith('@machize/'))

/**
 * The features an app has, from what is actually there: dependencies for the
 * framework domains, the tree for ui (web/) and cli (bin/basalt.ts). The
 * manifest supplies nothing the tree contradicts — a dependency removed since
 * the scaffold turns its feature off.
 */
export function inferOptions(dir: string, pkg: PackageJson, manifest: ProjectManifest | undefined): ProjectOptions {
  const deps = allDependencies(pkg)
  const has = (name: string): boolean => deps[name] !== undefined
  return {
    name: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : (manifest?.options.name ?? 'app'),
    tenancy: has('@basaltkit/tenancy'),
    auth: has('@basaltkit/auth'),
    billing: has('@basaltkit/subscriptions'),
    ui: existsSync(join(dir, 'web', 'package.json')),
    cli: existsSync(join(dir, 'bin', 'basalt.ts')),
    mcp: has('@basaltkit/mcp'),
    prisma: has('@prisma/client') || has('prisma'),
  }
}

/**
 * Loads the app at `dir`. Throws {@link NotABasaltAppError} with an actionable
 * message when there is no package.json or it has no @basaltkit dependency.
 */
export async function loadProject(
  dir: string,
  pmFlag?: PackageManager,
  userAgent: string | undefined = process.env['npm_config_user_agent'],
): Promise<ProjectContext> {
  let packageJsonText: string
  try {
    packageJsonText = await readFile(join(dir, 'package.json'), 'utf8')
  } catch {
    throw new NotABasaltAppError(
      `No package.json in ${dir}. Run this inside a Basalt app (or pass --cwd=<app dir>). To create one: npm create basalt <name>`,
    )
  }
  let packageJson: PackageJson
  try {
    packageJson = JSON.parse(packageJsonText) as PackageJson
  } catch (error) {
    throw new NotABasaltAppError(`${join(dir, 'package.json')} is not valid JSON: ${(error as Error).message}`)
  }
  if (!isBasaltPackage(packageJson)) {
    throw new NotABasaltAppError(
      `${join(dir, 'package.json')} has no @basaltkit/* dependency — this does not look like a Basalt app. To create one: npm create basalt <name>`,
    )
  }
  let web: ProjectContext['web']
  try {
    const text = await readFile(join(dir, 'web', 'package.json'), 'utf8')
    web = { text, json: JSON.parse(text) as PackageJson }
  } catch {
    web = undefined
  }
  const manifest = await readManifest(dir)
  const lockfiles = LOCKFILES.map(([file]) => file).filter((file) => existsSync(join(dir, file)))
  const { pm, source } = detectProjectPackageManager(packageJson, lockfiles, pmFlag, userAgent)
  return {
    dir,
    packageJsonText,
    packageJson,
    ...(web ? { web } : {}),
    ...(manifest ? { manifest } : {}),
    options: inferOptions(dir, packageJson, manifest),
    pm,
    pmSource: source,
    lockfiles,
  }
}
