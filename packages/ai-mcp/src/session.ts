import { nodeReader, type ProjectReader } from '@basaltkit/ai/analysis'
import type { AIProvider } from '@basaltkit/ai/workflows'
import { buildProvider } from './provider.js'

export interface SessionOptions {
  /** Workspace root the tools/resources default to. Defaults to `process.cwd()`. */
  cwd?: string
  /** Environment the provider config is read from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /**
   * How to build a project reader for a root. Defaults to the filesystem
   * (`nodeReader`). Injected in tests with an in-memory reader — no disk needed.
   */
  createReader?: (root: string) => ProjectReader
  /**
   * How to build the AI provider. Defaults to reading the session `env`. Injected
   * in tests with a mock provider — no network, no keys.
   */
  createProvider?: () => AIProvider
}

/** Resolved per-server session: workspace root, env, and how to read/plan. */
export interface Session {
  readonly workspaceRoot: string
  readonly env: Record<string, string | undefined>
  reader(root: string): ProjectReader
  /** Build the AI provider on demand — only the provider-backed tools call this. */
  provider(): AIProvider
}

export function createSession(options: SessionOptions = {}): Session {
  const workspaceRoot = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const createReader = options.createReader ?? nodeReader
  const provider = options.createProvider ?? (() => buildProvider(env))
  return {
    workspaceRoot,
    env,
    reader: (root) => createReader(root),
    provider,
  }
}

/**
 * Resolve the effective workspace root for a tool call: an explicit per-call
 * `workspaceRoot` argument, else the session default. (Workspace confinement for
 * write tools is an M3 concern; the M1/M2 tools are read-only.)
 */
export function resolveWorkspaceRoot(session: Session, arg: unknown): string {
  return typeof arg === 'string' && arg.trim() !== '' ? arg : session.workspaceRoot
}
