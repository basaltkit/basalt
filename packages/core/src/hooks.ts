/**
 * Registro global de hooks do ecossistema. Pacotes adicionam seus hooks
 * tipados via module augmentation:
 *
 * declare module '@machize/core' {
 *   interface MachizeHooks {
 *     'tenancy:switched': { tenantId: string }
 *   }
 * }
 */
export interface MachizeHooks {
  [hook: string]: unknown
}

export type HookHandler<P> = (payload: P) => void | Promise<void>

interface Registration {
  handler: HookHandler<unknown>
  priority: number
}

export class HookBus {
  private readonly handlers = new Map<string, Registration[]>()

  /** Registra um handler. Maior `priority` executa primeiro. Retorna função de unsubscribe. */
  on<K extends keyof MachizeHooks & string>(
    hook: K,
    handler: HookHandler<MachizeHooks[K]>,
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

  /** Executa os handlers em série, na ordem de prioridade. */
  async emit<K extends keyof MachizeHooks & string>(
    hook: K,
    payload: MachizeHooks[K],
  ): Promise<void> {
    const list = this.handlers.get(hook)
    if (!list) return
    for (const { handler } of [...list]) {
      await handler(payload)
    }
  }
}
