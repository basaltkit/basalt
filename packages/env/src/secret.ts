import { z } from 'zod'

/** Values that clearly aren't real secrets — rejected in production. */
const INSECURE = /change.?me|changeme|placeholder|example|secret|password|default|test|xxxx+|0000+/i

/**
 * Fail-closed environment check: only an EXPLICIT `NODE_ENV=development` or
 * `NODE_ENV=test` counts as a dev environment. Unset, empty, `staging`, a typo
 * of `production`, … are all treated as production, so a deploy that forgets
 * NODE_ENV can never fall back to a public, hardcoded `devDefault`.
 */
const isDevEnvironment = (): boolean => {
  const nodeEnv = process.env['NODE_ENV']
  return nodeEnv === 'development' || nodeEnv === 'test'
}

export interface SecretOptions {
  /** Minimum length. Default 16. */
  minLength?: number
  /**
   * Value used when the variable is unset AND `NODE_ENV` is explicitly
   * `development` or `test`. Anywhere else (production, staging, or NODE_ENV
   * unset) the variable is required — the fail-closed default.
   */
  devDefault?: string
}

/**
 * A Zod schema for a secret env var (JWT signing key, API key, …) that is
 * **fail-closed outside development**:
 *
 * - required unless `NODE_ENV` is explicitly `development` or `test` (an unset
 *   NODE_ENV counts as production — a `devDefault` never applies there);
 * - rejected outside development/test if it looks like a placeholder
 *   (`change-me`, `secret`, …);
 * - enforced to a minimum length everywhere.
 *
 *   APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' })
 *
 * A fresh app runs out of the box with `NODE_ENV=development`, and refuses to
 * boot anywhere else until a real secret is set.
 */
export function secret(options: SecretOptions = {}): z.ZodType<string> {
  const minLength = options.minLength ?? 16
  const checked = z
    .string()
    .min(minLength, `must be at least ${minLength} characters`)
    .refine(
      (value) => isDevEnvironment() || !INSECURE.test(value),
      'looks like a placeholder — set a strong, unique secret (only NODE_ENV=development/test accept one)',
    )

  if (options.devDefault === undefined) return checked

  return z.preprocess(
    (value) => (value === undefined && isDevEnvironment() ? options.devDefault : value),
    checked,
  ) as z.ZodType<string>
}
