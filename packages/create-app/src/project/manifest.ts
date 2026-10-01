import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectOptions } from '../templates.js'

/**
 * The scaffold manifest, `.basalt/project.json`: which create-basalt release
 * generated the project, with which options, and a content hash of every file
 * it wrote. `add` and `update` use the hashes to tell a template file nobody
 * touched (safe to regenerate or patch) from one the user edited (left alone,
 * with manual steps printed instead). Commit it with the project.
 *
 * Projects scaffolded before the manifest existed have none: their features
 * are inferred from package.json and every file counts as user-owned.
 */
export const MANIFEST_PATH = '.basalt/project.json'

export interface ProjectManifest {
  /** Bumped only on an incompatible change of this file's shape. */
  manifestVersion: 1
  generator: 'create-basalt'
  /** create-basalt version that created the project. */
  createdWith: string
  /** create-basalt version that last updated this manifest. */
  updatedWith: string
  options: ProjectOptions
  /** Project-relative path → `sha256-<hex>` of the content create-basalt wrote. */
  files: Record<string, string>
}

/** Content hash, insensitive to CRLF/LF (git autocrlf must not make a file look edited). */
export function hashContent(content: string): string {
  return `sha256-${createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex')}`
}

let cachedVersion: string | undefined
/** This create-basalt release's version (from its own package.json). */
export function ownVersion(): string {
  if (cachedVersion === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string }
      cachedVersion = pkg.version ?? '0.0.0'
    } catch {
      cachedVersion = '0.0.0'
    }
  }
  return cachedVersion
}

/** Files never hashed: package.json files are rewritten by every install/update, the manifest by itself. */
const UNTRACKED = (path: string): boolean => path === MANIFEST_PATH || path === 'package.json' || path.endsWith('/package.json')

export function createManifest(options: ProjectOptions, files: Readonly<Record<string, string>>): ProjectManifest {
  const version = ownVersion()
  return {
    manifestVersion: 1,
    generator: 'create-basalt',
    createdWith: version,
    updatedWith: version,
    options,
    files: Object.fromEntries(
      Object.entries(files)
        .filter(([path]) => !UNTRACKED(path))
        .map(([path, content]) => [path, hashContent(content)] as const)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  }
}

/** Records newly written files (and the options now on) in an existing manifest. */
export function extendManifest(
  manifest: ProjectManifest,
  options: ProjectOptions,
  written: Readonly<Record<string, string>>,
): ProjectManifest {
  const files = { ...manifest.files }
  for (const [path, content] of Object.entries(written)) {
    if (!UNTRACKED(path)) files[path] = hashContent(content)
  }
  return {
    ...manifest,
    updatedWith: ownVersion(),
    options,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
  }
}

export const serializeManifest = (manifest: ProjectManifest): string => `${JSON.stringify(manifest, null, 2)}\n`

/** Reads `.basalt/project.json`; undefined when absent or unreadable (treated as "no manifest"). */
export async function readManifest(dir: string): Promise<ProjectManifest | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, MANIFEST_PATH), 'utf8')) as Partial<ProjectManifest>
    if (parsed.generator !== 'create-basalt' || typeof parsed.files !== 'object' || parsed.files === null) return undefined
    return parsed as ProjectManifest
  } catch {
    return undefined
  }
}

/** Whether `content` is exactly what create-basalt wrote at `path` (per the manifest). */
export function isPristine(manifest: ProjectManifest | undefined, path: string, content: string): boolean {
  const recorded = manifest?.files[path]
  return recorded !== undefined && recorded === hashContent(content)
}
