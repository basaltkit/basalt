import { createToken, definePlugin, BasaltError } from '@basaltkit/core'

/** Structural schema compatible with Zod — same shape as core's ConfigSchema. */
export interface EventSchema<T> {
  safeParse(input: unknown): { success: boolean; data?: T; error?: unknown }
}

export class EventValidationError extends BasaltError {
  constructor(
    readonly event: string,
    readonly issues: unknown,
  ) {
    super('EVENT_INVALID', `Invalid payload for event "${event}": ${JSON.stringify(issues)}`)
  }
}

export interface BasaltEvent<T = void> {
  readonly name: string
  readonly schema?: EventSchema<T> | undefined
  /** phantom type */
  readonly __type?: T
}

/**
 * Defines a typed domain event:
 *
 * export const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))
 */
export function defineEvent<T = void>(name: string, schema?: EventSchema<T>): BasaltEvent<T> {
  return schema === undefined ? { name } : { name, schema }
}

export interface EventMeta {
  name: string
}

export type EventHandler<T> = (payload: T, meta: EventMeta) => void | Promise<void>

export interface ListenOptions {
  /** Higher priority runs first. Default: 0 */
  priority?: number
  /** Removes the listener after the first execution. */
  once?: boolean
}

interface Registration {
  pattern: string
  handler: EventHandler<unknown>
  priority: number
  once: boolean
}

export class EventBus {
  private registrations: Registration[] = []

  /**
   * Subscribes to a typed event or a string pattern with wildcards:
   * - `on(OrderCreated, h)` — typed payload
   * - `on('order.*', h)` — one wildcard segment
   * - `on('order.**', h)` or `on('**', h)` — any suffix
   * Returns an unsubscribe function.
   */
  on<T>(event: BasaltEvent<T>, handler: EventHandler<T>, options?: ListenOptions): () => void
  on(pattern: string, handler: EventHandler<unknown>, options?: ListenOptions): () => void
  on(
    eventOrPattern: BasaltEvent<unknown> | string,
    handler: EventHandler<never>,
    options: ListenOptions = {},
  ): () => void {
    const registration: Registration = {
      pattern: typeof eventOrPattern === 'string' ? eventOrPattern : eventOrPattern.name,
      handler: handler as EventHandler<unknown>,
      priority: options.priority ?? 0,
      once: options.once ?? false,
    }
    this.registrations.push(registration)
    return () => {
      this.registrations = this.registrations.filter((r) => r !== registration)
    }
  }

  once<T>(event: BasaltEvent<T>, handler: EventHandler<T>): () => void {
    return this.on(event, handler, { once: true })
  }

  /**
   * Emits an event: validates the payload (if there is a schema) and runs the
   * listeners in series by priority. All listeners run even if one of them
   * fails; failures are aggregated into an AggregateError at the end.
   */
  async emit<T>(event: BasaltEvent<T>, ...args: T extends void ? [] : [T]): Promise<void> {
    const payload = validate(event, args[0])
    const meta: EventMeta = { name: event.name }
    const matched = this.registrations
      .filter((r) => matches(r.pattern, event.name))
      .sort((a, b) => b.priority - a.priority)

    const errors: unknown[] = []
    for (const registration of matched) {
      if (registration.once) {
        this.registrations = this.registrations.filter((r) => r !== registration)
      }
      try {
        await registration.handler(payload, meta)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Failure in ${errors.length} listener(s) of "${event.name}"`)
    }
  }

  listenerCount(eventName: string): number {
    return this.registrations.filter((r) => matches(r.pattern, eventName)).length
  }
}

function validate<T>(event: BasaltEvent<T>, payload: unknown): unknown {
  if (!event.schema) return payload
  const result = event.schema.safeParse(payload)
  if (!result.success) {
    const issues =
      (result.error as { issues?: unknown[] } | undefined)?.issues ?? result.error ?? 'unknown'
    throw new EventValidationError(event.name, issues)
  }
  return result.data
}

/** `*` matches exactly one segment; `**` matches one or more segments. */
function matches(pattern: string, eventName: string): boolean {
  if (pattern === eventName) return true
  const patternSegments = pattern.split('.')
  const nameSegments = eventName.split('.')

  for (let i = 0; i < patternSegments.length; i++) {
    const segment = patternSegments[i]
    if (segment === '**') return i < nameSegments.length
    if (i >= nameSegments.length) return false
    if (segment !== '*' && segment !== nameSegments[i]) return false
  }
  return patternSegments.length === nameSegments.length
}

export const EVENTS = createToken<EventBus>('events')

export function eventsPlugin() {
  return definePlugin({
    name: 'basalt:events',
    register({ container }) {
      container.singleton(EVENTS, () => new EventBus())
    },
  })
}
export {
  Outbox,
  MemoryOutboxStore,
  outboxPlugin,
  OUTBOX,
  type OutboxEntry,
  type OutboxStore,
  type OutboxDispatch,
  type OutboxOptions,
  type OutboxPluginOptions,
  type FlushResult,
} from './outbox.js'
