import { createToken, definePlugin, tryCtx } from '@machize/core'
import { pino, type DestinationStream, type Logger as PinoLogger } from 'pino'

export type Logger = PinoLogger<string, boolean>

/** ALS context fields automatically promoted onto every log line. */
const CONTEXT_FIELDS = ['requestId', 'correlationId', 'traceId', 'userId', 'tenantId'] as const

const DEFAULT_REDACT = [
  'password',
  '*.password',
  'token',
  '*.token',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
  'headers.authorization',
]

export interface LoggerOptions {
  level?: string
  /** Human-readable output for dev (requires pino-pretty installed). Default: false (JSON). */
  pretty?: boolean
  /** Extra redaction paths, added to the defaults. */
  redact?: string[]
  /** Fixed fields on every log line (e.g. `{ service: 'api' }`). */
  base?: Record<string, unknown>
  /** Destination stream — used in tests to capture the output. */
  destination?: DestinationStream
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
    name: 'machize:logger',
    register({ container }) {
      container.singleton(LOGGER, () => createLogger(options))
    },
    async shutdown({ container }) {
      const logger = container.get(LOGGER)
      logger.flush?.()
    },
  })
}
