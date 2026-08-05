import { createToken, definePlugin, MachizeError } from '@machize/core'

/** Schema estrutural compatível com Zod — mesma forma do ConfigSchema do core. */
export interface EventSchema<T> {
  safeParse(input: unknown): { success: boolean; data?: T; error?: unknown }
}

export class EventValidationError extends MachizeError {
  constructor(
    readonly event: string,
    readonly issues: unknown,
  ) {
    super('EVENT_INVALID', `Payload inválido para o evento "${event}": ${JSON.stringify(issues)}`)
  }
}

export interface MachizeEvent<T = void> {
  readonly name: string
  readonly schema?: EventSchema<T> | undefined
  /** phantom type */
  readonly __type?: T
}

/**
 * Define um evento de domínio tipado:
 *
 * export const OrderCreated = defineEvent('order.created', z.object({ orderId: z.string() }))
 */
export function defineEvent<T = void>(name: string, schema?: EventSchema<T>): MachizeEvent<T> {
  return schema === undefined ? { name } : { name, schema }
}

export interface EventMeta {
  name: string
}

export type EventHandler<T> = (payload: T, meta: EventMeta) => void | Promise<void>

export interface ListenOptions {
  /** Maior prioridade executa primeiro. Default: 0 */
  priority?: number
  /** Remove o listener após a primeira execução. */
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
   * Assina um evento tipado ou um padrão string com wildcards:
   * - `on(OrderCreated, h)` — payload tipado
   * - `on('order.*', h)` — um segmento curinga
   * - `on('order.**', h)` ou `on('**', h)` — qualquer sufixo
   * Retorna função de unsubscribe.
   */
  on<T>(event: MachizeEvent<T>, handler: EventHandler<T>, options?: ListenOptions): () => void
  on(pattern: string, handler: EventHandler<unknown>, options?: ListenOptions): () => void
  on(
    eventOrPattern: MachizeEvent<unknown> | string,
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

  once<T>(event: MachizeEvent<T>, handler: EventHandler<T>): () => void {
    return this.on(event, handler, { once: true })
  }

  /**
   * Emite um evento: valida o payload (se houver schema) e executa os
   * listeners em série por prioridade. Todos os listeners rodam mesmo se
   * algum falhar; falhas são agregadas num AggregateError ao final.
   */
  async emit<T>(event: MachizeEvent<T>, ...args: T extends void ? [] : [T]): Promise<void> {
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
      throw new AggregateError(errors, `Falha em ${errors.length} listener(s) de "${event.name}"`)
    }
  }

  listenerCount(eventName: string): number {
    return this.registrations.filter((r) => matches(r.pattern, eventName)).length
  }
}

function validate<T>(event: MachizeEvent<T>, payload: unknown): unknown {
  if (!event.schema) return payload
  const result = event.schema.safeParse(payload)
  if (!result.success) {
    const issues =
      (result.error as { issues?: unknown[] } | undefined)?.issues ?? result.error ?? 'desconhecido'
    throw new EventValidationError(event.name, issues)
  }
  return result.data
}

/** `*` casa exatamente um segmento; `**` casa um ou mais segmentos. */
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
    name: 'machize:events',
    register({ container }) {
      container.singleton(EVENTS, () => new EventBus())
    },
  })
}
