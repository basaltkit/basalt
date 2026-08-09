/**
 * Global hook registry for the ecosystem. Packages add their typed hooks
 * via module augmentation:
 *
 * declare module '@basaltkit/core' {
 *   interface BasaltHooks {
 *     'tenancy:switched': { tenantId: string }
 *   }
 * }
 */
export interface BasaltHooks {
  [hook: string]: unknown
}

export type HookHandler<P> = (payload: P) => void | Promise<void>

/** Receives every hook emission — the audit trail and devtools hang here. */
export type AnyHookHandler = (hook: string, payload: unknown) => void | Promise<void>

interface Registration {
  handler: HookHandler<unknown>
  priority: number
}

export class HookBus {
  private readonly handlers = new Map<string, Registration[]>()
  private readonly anyHandlers: AnyHookHandler[] = []

  /** Registers a handler. Higher `priority` runs first. Returns an unsubscribe function. */
  on<K extends keyof BasaltHooks & string>(
    hook: K,
    handler: HookHandler<BasaltHooks[K]>,
    options: { priority?: number } = {},
  ): () => void {
    const registration: Registration = {
      handler: handler as HookHandler<unknown>,
      priority: options.priority ?? 0,
    }
    const list = this.handlers.get(hook) ?? []
    list.push(registration)
    list.sort((a, b) => b.priority - a.priority)
    this.handlers.set(hook, list)
    return () => {
      const current = this.handlers.get(hook)
      if (!current) return
      const index = current.indexOf(registration)
      if (index >= 0) current.splice(index, 1)
    }
  }

  /** Subscribes to every hook. Runs after the specific handlers. */
  onAny(handler: AnyHookHandler): () => void {
    this.anyHandlers.push(handler)
    return () => {
      const index = this.anyHandlers.indexOf(handler)
      if (index >= 0) this.anyHandlers.splice(index, 1)
    }
  }

  /** Runs the handlers in series, in priority order, then the onAny handlers. */
  async emit<K extends keyof BasaltHooks & string>(
    hook: K,
    payload: BasaltHooks[K],
  ): Promise<void> {
    for (const { handler } of [...(this.handlers.get(hook) ?? [])]) {
      await handler(payload)
    }
    for (const handler of [...this.anyHandlers]) {
      await handler(hook, payload)
    }
  }
}
