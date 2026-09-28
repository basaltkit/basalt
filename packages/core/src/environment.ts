/**
 * The single, fail-closed answer to "is this production?" shared by every
 * Basalt package that changes a security default on `NODE_ENV`.
 *
 * Only an EXPLICIT `NODE_ENV=development` or `NODE_ENV=test` counts as a
 * non-production environment. Unset, empty, `staging`, a typo of
 * `production`, … are all treated as production, so a deploy that forgets
 * `NODE_ENV` gets the strict defaults (strong secrets, `Secure` cookies,
 * redacted logs) instead of the development ones.
 *
 * Vitest sets `NODE_ENV=test` when it is unset, so test suites keep the
 * development defaults without extra configuration.
 */
export function isProductionEnvironment(
  nodeEnv: string | undefined = readNodeEnv(),
): boolean {
  return nodeEnv !== 'development' && nodeEnv !== 'test'
}

/** `process.env.NODE_ENV`, or undefined on a runtime without `process` (→ production). */
function readNodeEnv(): string | undefined {
  return typeof process === 'undefined' ? undefined : process.env?.['NODE_ENV']
}
