import { BasaltError } from '@basaltkit/core'
import { z } from 'zod'

export class EnvValidationError extends BasaltError {
  constructor(readonly report: string[]) {
    super(
      'ENV_INVALID',
      `Invalid environment variables:\n${report.map((line) => `  - ${line}`).join('\n')}`,
    )
  }
}

/** Thrown by {@link defineEnv} for a prefix that cannot form a valid variable name. */
export class EnvPrefixError extends BasaltError {
  constructor(readonly prefix: string) {
    super(
      'ENV_PREFIX_INVALID',
      `Invalid env prefix ${JSON.stringify(prefix)}: use UPPERCASE letters, digits and single ` +
        'underscores, starting with a letter and not ending in an underscore (e.g. "MY_SAAS"). ' +
        'The prefix is joined to each variable name with "_", so it must itself be a valid ' +
        'environment variable name.',
    )
  }
}

/**
 * `NODE_ENV` is a Node-wide convention read by the whole toolchain (and by
 * `secret()` inside this package), so it is NEVER prefixed.
 */
const NEVER_PREFIXED = 'NODE_ENV'

/** `MY_SAAS`, `APP`, `A1_B2` — uppercase/digits, single inner underscores. */
const VALID_PREFIX = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/

export interface EnvPrefix {
  /** The prefix itself, e.g. `'MY_SAAS'` — uppercase letters, digits and underscores. */
  value: string
  /**
   * Also accept the bare `<NAME>` when `<PREFIX>_<NAME>` is unset. Default:
   * `true`, so a deployment that already exports the generic names keeps
   * booting. Set `false` to require the prefixed names and make a stray
   * `DATABASE_URL` in the shell impossible to pick up by accident.
   */
  fallback?: boolean
}

export interface DefineEnvOptions {
  /** Source of the variables. Default: process.env */
  source?: Record<string, string | undefined>
  /**
   * Read every variable as `<PREFIX>_<NAME>` first (`MY_SAAS_DATABASE_URL` for
   * `DATABASE_URL`), so a generic name exported by another project in the same
   * shell cannot be picked up by accident. A bare string is shorthand for
   * `{ value, fallback: true }`. `NODE_ENV` is never prefixed. The returned
   * object keeps the shape's keys — `env.DATABASE_URL`, not `env.MY_SAAS_…`.
   */
  prefix?: string | EnvPrefix
}

/** How one shape key is read from the source, for lookup and for error messages. */
interface Lookup {
  /** The key whose value was used, or — when nothing was set — the key to report. */
  readonly label: string
  readonly value: string | undefined
}

const resolveLookup = (
  key: string,
  source: Record<string, string | undefined>,
  prefix: EnvPrefix | undefined,
): Lookup => {
  if (prefix === undefined || key === NEVER_PREFIXED) return { label: key, value: source[key] }

  const prefixed = `${prefix.value}_${key}`
  const prefixedValue = source[prefixed]
  if (prefixedValue !== undefined) return { label: prefixed, value: prefixedValue }

  const fallback = prefix.fallback ?? true
  if (!fallback) return { label: prefixed, value: undefined }

  const bareValue = source[key]
  if (bareValue !== undefined) return { label: key, value: bareValue }
  // Unset under both names: name both, so the report matches what was looked for.
  return { label: `${prefixed} (or ${key})`, value: undefined }
}

const normalizePrefix = (prefix: string | EnvPrefix | undefined): EnvPrefix | undefined => {
  if (prefix === undefined) return undefined
  const normalized = typeof prefix === 'string' ? { value: prefix } : prefix
  if (!VALID_PREFIX.test(normalized.value)) throw new EnvPrefixError(normalized.value)
  return normalized
}

/**
 * Validates and types environment variables. Aggregates ALL errors into a single
 * report instead of failing one variable at a time.
 *
 * export const env = defineEnv({
 *   DATABASE_URL: z.string().url(),
 *   PORT: z.coerce.number().default(3000),
 * })
 *
 * With `{ prefix: 'MY_SAAS' }` each variable is read as `MY_SAAS_DATABASE_URL`
 * first, falling back to the bare `DATABASE_URL`.
 */
export function defineEnv<TShape extends z.ZodRawShape>(
  shape: TShape,
  options: DefineEnvOptions = {},
): z.infer<z.ZodObject<TShape>> {
  const source = options.source ?? process.env
  const prefix = normalizePrefix(options.prefix)

  // Without a prefix the source is parsed as-is — same object, same behaviour.
  let input: Record<string, string | undefined> = source
  const labels = new Map<string, string>()
  if (prefix !== undefined) {
    const mapped: Record<string, string | undefined> = {}
    for (const key of Object.keys(shape)) {
      const { label, value } = resolveLookup(key, source, prefix)
      labels.set(key, label)
      // Absent under every name: leave the key out, so defaults and
      // preprocess(undefined) (secret()'s devDefault) behave as usual.
      if (value !== undefined) mapped[key] = value
    }
    input = mapped
  }

  const result = z.object(shape).safeParse(input)

  if (!result.success) {
    const report = result.error.issues.map((issue) => {
      const [first, ...rest] = issue.path
      const name = typeof first === 'string' ? (labels.get(first) ?? first) : String(first ?? '')
      const path = [name, ...rest.map(String)].join('.') || '(root)'
      return `${path}: ${issue.message}`
    })
    throw new EnvValidationError(report)
  }

  return Object.freeze(result.data) as z.infer<z.ZodObject<TShape>>
}

export { secret, type SecretOptions } from './secret.js'
