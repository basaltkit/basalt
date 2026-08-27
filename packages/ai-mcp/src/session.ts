import { nodeReader, type ProjectReader } from '@basaltkit/ai/analysis'

export interface SessionOptions {
  /** Workspace root the tools/resources default to. Defaults to `process.cwd()`. */
  cwd?: string
  /**
   * How to build a project reader for a root. Defaults to the filesystem
   * (`nodeReader`). Injected in tests with an in-memory reader — no disk needed.
   */
  createReader?: (root: string) => ProjectReader
}

/** Resolved per-server session: the default workspace root and how to read a project. */
export interface Session {
  readonly workspaceRoot: string
  reader(root: string): ProjectReader
}

export function createSession(options: SessionOptions = {}): Session {
  const workspaceRoot = options.cwd ?? process.cwd()
  const createReader = options.createReader ?? nodeReader
  return {
    workspaceRoot,
    reader: (root) => createReader(root),
  }
}

/**
 * Resolve the effective workspace root for a tool call: an explicit per-call
 * `workspaceRoot` argument, else the session default. (Workspace confinement for
 * write tools is an M3 concern; these M1 tools are read-only.)
 */
export function resolveWorkspaceRoot(session: Session, arg: unknown): string {
  return typeof arg === 'string' && arg.trim() !== '' ? arg : session.workspaceRoot
}
