import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** Thrown when a workspaceRoot or a target path would escape the launch subtree. */
export class WorkspaceEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceEscapeError'
  }
}

/** True when `child` is `base` or lives inside it (lexically). */
export function within(base: string, child: string): boolean {
  if (child === base) return true
  const rel = relative(base, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Realpath of the nearest existing ancestor of `target` (so symlink escapes are seen even for not-yet-created paths). */
function nearestExistingRealpath(target: string): string {
  let cur = resolve(target)
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) return cur
    cur = parent
  }
  try {
    return realpathSync(cur)
  } catch {
    return cur
  }
}

/**
 * Resolve the confined write root for a call. An explicit `requested`
 * workspaceRoot is honoured only when it stays inside the launch subtree
 * (after symlink resolution); otherwise a {@link WorkspaceEscapeError} is thrown.
 * An autonomous agent must not be able to redirect writes outside the project.
 */
export function resolveWriteRoot(launchRoot: string, requested: string | undefined): string {
  const base = nearestExistingRealpath(launchRoot)
  if (requested === undefined || requested.trim() === '') return base
  const candidate = resolve(base, requested)
  if (!within(base, nearestExistingRealpath(candidate)) || !within(base, candidate)) {
    throw new WorkspaceEscapeError(`workspaceRoot '${requested}' escapes the launch directory (${base})`)
  }
  return candidate
}

/**
 * Assert every relative target path stays within `root`: no absolute paths, no
 * `..` traversal, and no symlink that resolves outside. Called before any write.
 */
export function assertConfined(root: string, relPaths: string[]): void {
  const base = nearestExistingRealpath(root)
  for (const rel of relPaths) {
    if (isAbsolute(rel)) throw new WorkspaceEscapeError(`absolute path not allowed: ${rel}`)
    const target = resolve(root, rel)
    if (!within(root, target)) throw new WorkspaceEscapeError(`path escapes workspace: ${rel}`)
    if (!within(base, nearestExistingRealpath(target))) {
      throw new WorkspaceEscapeError(`path resolves outside workspace via symlink: ${rel}`)
    }
  }
}
