import { createToken, definePlugin, tryCtx } from '@basaltkit/core'
import { pino, stdSerializers, type Bindings, type DestinationStream, type Logger as PinoLogger } from 'pino'

export type Logger = PinoLogger<string, boolean>

/**
 * The log levels Pino supports, most to least severe. `'silent'` disables all
 * output. Use `LogLevel` to type an option and `LOG_LEVELS` for a runtime
 * validator (e.g. `z.enum(LOG_LEVELS)`) — so a level is never a free-form string
 * the user can typo.
 */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/** ALS context fields automatically promoted onto every log line. */
const CONTEXT_FIELDS = ['requestId', 'correlationId', 'traceId', 'userId', 'tenantId'] as const

// Pino path-based redaction for the well-known top-level and one-level-deep
// carriers. It is kept as defense in depth (and to host user-supplied
// `redact` paths); the recursive key redactor below is what guarantees
// coverage at any depth, inside arrays, on errors and on child bindings.
const REDACT_KEYS = [
  'password',
  'pass',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'jwt',
  'apiKey',
  'api_key',
  'apikey',
  'mfaCode',
  'otp',
  'resetToken',
  'authorization',
  'cookie',
  'creditCard',
  'cardNumber',
  'cvv',
  'cvc',
  'ssn',
]

const DEFAULT_REDACT = [
  ...REDACT_KEYS,
  ...REDACT_KEYS.map((k) => `*.${k}`),
  // Common request-shaped nesting that sits two levels deep.
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'request.headers.authorization',
  'request.headers.cookie',
]

const CENSOR = '[REDACTED]'

/**
 * Secret-bearing key names, compared after normalization (lower-cased, with
 * every non-alphanumeric character removed), so `access_token`, `accessToken`,
 * `Access-Token` and `ACCESS_TOKEN` all match the same entry.
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwords',
  'passwd',
  'pwd',
  'pass',
  'passphrase',
  'passwordhash',
  'secret',
  'secrets',
  'token',
  'tokens',
  'jwt',
  'otp',
  'mfacode',
  'totpcode',
  'apikey',
  'apikeys',
  'privatekey',
  'secretaccesskey',
  'authorization',
  'proxyauthorization',
  'cookie',
  'cookies',
  'setcookie',
  'credential',
  'credentials',
  'recoverycode',
  'backupcode',
  'creditcard',
  'cardnumber',
  'cvv',
  'cvc',
  'ssn',
  'connectionstring',
])

/**
 * Normalized suffixes that mark a key as secret-bearing wherever it appears:
 * `refreshToken`/`id_token`/`csrfToken`, `clientSecret`/`mfaSecret`/
 * `webhookSecret`/`APP_SECRET`, `x-api-key`, `private_key`, `userPassword`,
 * `stripe_secret_key`/`signingKey`/`mfaEncryptionKey`, `recoveryCodes` and
 * the session cookie's bearer value (`sessionId`). A plural `tokens` suffix is
 * deliberately absent: `inputTokens`/`maxTokens` are counts, not credentials.
 */
const SENSITIVE_SUFFIXES = [
  'password',
  'passwords',
  'passwordhash',
  'secret',
  'secrets',
  'token',
  'apikey',
  'apikeys',
  'privatekey',
  'privatekeys',
  'secretkey',
  'secretaccesskey',
  'signingkey',
  'encryptionkey',
  'masterkey',
  'authorization',
  'cookie',
  'cookies',
  'recoverycodes',
  'backupcodes',
  'sessionid',
]

/** Beyond this nesting depth values are censored instead of inspected. */
const MAX_REDACT_DEPTH = 10

/**
 * Upper bound on objects inspected per log line. Walking a large object graph
 * (e.g. a socket reachable through several paths) would otherwise cost time
 * exponential in its depth; past the budget values are censored.
 */
const MAX_REDACT_NODES = 5000

/**
 * Top-level keys whose class-instance values are left untouched for the
 * logger's per-key serializers (Fastify/pino-http `req`/`res`), which run
 * after this formatter and read prototype getters a plain copy would lose.
 */
const SERIALIZER_KEYS = new Set(['req', 'res'])

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (k.length === 0) return false
  if (SENSITIVE_KEYS.has(k)) return true
  for (const suffix of SENSITIVE_SUFFIXES) {
    if (k.endsWith(suffix)) return true
  }
  return false
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

interface RedactState {
  ancestors: WeakSet<object>
  remaining: number
}

/**
 * Serializes an Error (pino's standard error serializer) and redacts the
 * result. Nested errors (custom Error-valued properties, `AggregateError`
 * members) are redacted from the ORIGINAL errors, because the serializer turns
 * them into non-plain objects. The error's constructor is kept (non-enumerable)
 * so pino's `err` serializer, which runs again after this formatter, still
 * reports the real `type` instead of `Object`.
 */
function redactError(err: Error, depth: number, state: RedactState): unknown {
  const serialized = stdSerializers.err(err) as unknown as Record<string, unknown>
  const original = err as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(serialized)) {
    let v = serialized[key]
    if (key === 'aggregateErrors' && Array.isArray(original['errors'])) v = original['errors']
    else if (original[key] instanceof Error) v = original[key]
    out[key] = isSensitiveKey(key) && v !== undefined ? CENSOR : redactDeep(v, depth + 1, state)
  }
  Object.defineProperty(out, 'constructor', { value: err.constructor, enumerable: false })
  return out
}

/**
 * Returns a copy of `value` with every secret-bearing key censored, at any
 * depth and inside arrays. The caller's objects are never mutated. It mirrors
 * what JSON serialization will emit: `toJSON()` results are redacted (axios'
 * `AxiosHeaders`, Dates), class instances are walked by their own enumerable
 * keys, and Errors go through pino's error serializer, since their custom
 * properties (e.g. an HTTP client's `config.headers`) often carry credentials.
 */
function redactDeep(value: unknown, depth: number, state: RedactState, key?: string): unknown {
  if (value === null || typeof value !== 'object') return value
  if (state.ancestors.has(value)) return '[Circular]'
  if (
    depth === 1 &&
    key !== undefined &&
    SERIALIZER_KEYS.has(key) &&
    !Array.isArray(value) &&
    !isPlainObject(value) &&
    !(value instanceof Error)
  ) {
    return value
  }
  if (depth > MAX_REDACT_DEPTH || state.remaining <= 0) return '[Truncated]'
  state.remaining--

  state.ancestors.add(value)
  try {
    if (value instanceof Error) return redactError(value, depth, state)

    const toJSON = (value as { toJSON?: unknown }).toJSON
    if (typeof toJSON === 'function') {
      let json: unknown
      try {
        json = (toJSON as (k: string) => unknown).call(value, key ?? '')
      } catch {
        return '[Unserializable]'
      }
      if (json !== value) return redactDeep(json, depth, state, key)
    }

    if (Array.isArray(value)) {
      return value.map((item) => redactDeep(item, depth + 1, state))
    }
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value)) {
      const v = (value as Record<string, unknown>)[k]
      out[k] = isSensitiveKey(k) && v !== undefined ? CENSOR : redactDeep(v, depth + 1, state, k)
    }
    return out
  } finally {
    state.ancestors.delete(value)
  }
}

function redactRecord(obj: Record<string, unknown>): Record<string, unknown> {
  return redactDeep(obj, 0, { ancestors: new WeakSet(), remaining: MAX_REDACT_NODES }) as Record<
    string,
    unknown
  >
}

export interface LoggerOptions {
  /**
   * Minimum log level — one of {@link LOG_LEVELS}. `'silent'` disables output.
   *
   * @default "info"
   */
  level?: LogLevel;

  /**
   * Human-readable output for development.
   *
   * Requires `pino-pretty` to be installed.
   *
   * @default false
   */
  pretty?: boolean;

  /**
   * Additional paths to redact from log output.
   *
   * These are added to the default redaction paths.
   */
  redact?: string[];

  /**
   * Fixed fields included in every log entry.
   *
   * Example:
   * `{ service: 'api', version: '1.0.0' }`
   */
  base?: Bindings;

  /**
   * Destination stream used by Pino.
   *
   * Useful for tests or custom output streams.
   */
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const pinoOptions: Parameters<typeof pino>[0] = {
    level: options.level ?? 'info',
    base: options.base ?? {},
    redact: {
      paths: [...DEFAULT_REDACT, ...(options.redact ?? [])],
      censor: CENSOR,
    },
    // Secure by default: every log object and every child binding is walked
    // for secret-bearing key names at any depth (see `redactDeep`).
    formatters: { log: redactRecord, bindings: redactRecord },
    mixin: contextFields,
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  }
  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions)
}

/**
 * Extracts fields from the active context. `tenant`/`user` (objects with `id`)
 * become `tenantId`/`userId` — without the dev passing anything in log calls.
 */
function contextFields(): Record<string, unknown> {
  const context = tryCtx()
  if (!context) return {}

  const fields: Record<string, unknown> = {}
  for (const key of CONTEXT_FIELDS) {
    if (context[key] !== undefined) fields[key] = context[key]
  }
  const tenant = context['tenant'] as { id?: string } | undefined
  if (fields['tenantId'] === undefined && tenant?.id !== undefined) fields['tenantId'] = tenant.id
  const user = context['user'] as { id?: string } | undefined
  if (fields['userId'] === undefined && user?.id !== undefined) fields['userId'] = user.id
  return fields
}

export const LOGGER = createToken<Logger>('logger')

export function loggerPlugin(options: LoggerOptions = {}) {
  return definePlugin({
    name: 'basalt:logger',
    register({ container }) {
      container.singleton(LOGGER, () => createLogger(options))
    },
    async shutdown({ container }) {
      const logger = container.get(LOGGER)
      logger.flush?.()
    },
  })
}
