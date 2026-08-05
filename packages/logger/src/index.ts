import { createToken, definePlugin, tryCtx } from '@machize/core'
import { pino, type DestinationStream, type Logger as PinoLogger } from 'pino'

export type Logger = PinoLogger<string, boolean>

/** Campos do contexto ALS promovidos automaticamente para todo log. */
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
  /** Saída legível para dev (requer pino-pretty instalado). Default: false (JSON). */
  pretty?: boolean
  /** Paths extras de redação, somados aos defaults. */
  redact?: string[]
  /** Campos fixos em todo log (ex.: `{ service: 'api' }`). */
  base?: Record<string, unknown>
  /** Stream de destino — usado em testes para capturar a saída. */
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
 * Extrai campos do contexto ativo. `tenant`/`user` (objetos com `id`)
 * viram `tenantId`/`userId` — sem o dev passar nada nas chamadas de log.
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
