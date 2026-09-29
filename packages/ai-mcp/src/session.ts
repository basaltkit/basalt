import { nodeReader, type ProjectReader } from '@basaltkit/ai/analysis'
import type { AIProvider } from '@basaltkit/ai/workflows'
import { buildProvider } from './provider.js'
import { resolveReadRoot } from './safety.js'

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
  /**
   * Let `basalt_make` apply WITHOUT a confirmation when the client cannot be
   * asked (no elicitation support — e.g. over HTTP, or a stdio client that did
   * not announce the capability). Default `false`: such an apply is refused
   * (fail closed). The bin's `--allow-unconfirmed-apply` flag sets it.
   */
  allowUnconfirmedApply?: boolean
  /**
   * Start even when `NODE_ENV` is `production`. Default `false`: the bridge is
   * dev-only and refuses to start there (`AiMcpProductionError`). The bin's
   * `--allow-production` flag (or `BASALT_AI_MCP_ALLOW_PRODUCTION=1`) sets it.
   */
  allowProduction?: boolean
}

/** Resolved per-server session: workspace root, env, and how to read/plan. */
export interface Session {
  readonly workspaceRoot: string
  readonly env: Record<string, string | undefined>
  reader(root: string): ProjectReader
  /** Build the AI provider on demand — only the provider-backed tools call this. */
  provider(): AIProvider
  /** Whether an `apply` may proceed when the client cannot confirm it. */
  readonly allowUnconfirmedApply: boolean
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
    allowUnconfirmedApply: options.allowUnconfirmedApply === true,
  }
}

/**
 * Resolve the effective workspace root for a read tool call: an explicit
 * per-call `workspaceRoot` argument, else the session default. The argument is
 * confined to the session root (the configured project, `--cwd` or the launch
 * directory) — a path outside it, or a symlink that resolves outside it,
 * throws {@link WorkspaceEscapeError}. Write tools use `resolveWriteRoot`.
 */
export function resolveWorkspaceRoot(session: Session, arg: unknown): string {
  return resolveReadRoot(session.workspaceRoot, typeof arg === 'string' ? arg : undefined)
}
