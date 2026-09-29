/**
 * Runtime half of the "AI is dev-only" rule. The manifest guard (a workspace
 * test) keeps `@basaltkit/ai-mcp` out of every package's runtime dependencies;
 * this check covers what a manifest cannot see — the bridge being started in a
 * production process (a deployed app that imported it, a container that runs
 * the bin). An MCP bridge that plans and writes code has no business there.
 *
 * The check is local on purpose: this package never depends on
 * `@basaltkit/core` (it only uses the framework's public AI APIs). And only an
 * EXPLICIT `NODE_ENV=production` refuses. `@basaltkit/core`'s
 * `isProductionEnvironment()` treats an unset `NODE_ENV` as production (right
 * for secrets checks, fail closed), but MCP clients such as Claude Desktop
 * launch the bin without any `NODE_ENV` — that is the normal dev path and must
 * keep working.
 */

/** Env var that overrides the guard (`1` or `true`), for the rare deliberate case. */
export const ALLOW_PRODUCTION_ENV = 'BASALT_AI_MCP_ALLOW_PRODUCTION'

/** Thrown when the dev-only MCP bridge is started with `NODE_ENV=production`. */
export class AiMcpProductionError extends Error {
  constructor() {
    super(
      '@basaltkit/ai-mcp is a dev-only tool and refuses to start with NODE_ENV=production. ' +
        `Run it in development, or override deliberately with --allow-production (${ALLOW_PRODUCTION_ENV}=1).`,
    )
    this.name = 'AiMcpProductionError'
  }
}

/**
 * Throw {@link AiMcpProductionError} when `env.NODE_ENV` is `production` —
 * unless `allowProduction` is set or `env` carries the override variable.
 */
export function assertDevOnly(env: Record<string, string | undefined>, allowProduction = false): void {
  if (env['NODE_ENV']?.trim().toLowerCase() !== 'production') return
  const override = env[ALLOW_PRODUCTION_ENV]?.trim().toLowerCase()
  if (allowProduction || override === '1' || override === 'true') return
  throw new AiMcpProductionError()
}
