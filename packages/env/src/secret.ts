import { z } from 'zod'

/** Values that clearly aren't real secrets — rejected in production. */
const INSECURE = /change.?me|changeme|placeholder|example|secret|password|default|test|xxxx+|0000+/i

const isProduction = (): boolean => process.env['NODE_ENV'] === 'production'

export interface SecretOptions {
  /** Minimum length. Default 16. */
  minLength?: number
  /**
   * Value used in non-production when the variable is unset. In production the
   * variable is always required (no fallback) — the fail-closed default.
   */
  devDefault?: string
}

/**
 * A Zod schema for a secret env var (JWT signing key, API key, …) that is
 * **fail-closed in production**:
 *
 * - required in production (a `devDefault` never applies there);
 * - rejected in production if it looks like a placeholder (`change-me`, `secret`, …);
 * - enforced to a minimum length everywhere.
 *
 *   APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' })
 *
 * A fresh app runs out of the box in development, and refuses to boot in
 * production until a real secret is set.
 */
export function secret(options: SecretOptions = {}): z.ZodType<string> {
  const minLength = options.minLength ?? 16
  const checked = z
    .string()
    .min(minLength, `must be at least ${minLength} characters`)
    .refine(
      (value) => !(isProduction() && INSECURE.test(value)),
      'looks like a placeholder — set a strong, unique secret in production',
    )

  if (options.devDefault === undefined) return checked

  return z.preprocess(
    (value) => (value === undefined && !isProduction() ? options.devDefault : value),
    checked,
  ) as z.ZodType<string>
}
