import { createToken, definePlugin, tryCtx } from '@basaltkit/core'
import { pino, type Bindings, type DestinationStream, type Logger as PinoLogger } from 'pino'

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

// Keys whose values are redacted wherever they appear (top level and one level
// of nesting, e.g. req.body.password). The previous list matched only the exact
// key `token`, so `accessToken`/`refreshToken`/`cookie` logged in clear — this
// covers the secret-bearing names this framework actually mints, plus the usual
// credential/header carriers. Mirrors the audit module's stronger coverage.
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
      censor: '[REDACTED]',
    },
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
