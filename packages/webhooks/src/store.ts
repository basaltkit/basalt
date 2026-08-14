import { randomUUID } from 'node:crypto'

export interface WebhookEndpoint {
  id: string
  url: string
  /** Event patterns this endpoint receives: exact (`invoice.paid`), prefix (`invoice.*`) or `*`. */
  events: string[]
  /** Restrict delivery to one tenant. Omit to receive from all tenants. */
  tenantId?: string
  /** Per-endpoint signing secret (overrides the deliverer default). */
  secret?: string
  /** Soft-disable without deleting. Default true. */
  active?: boolean
}

/** True when `event` matches any of the endpoint's patterns. */
export function matchesEvent(patterns: string[], event: string): boolean {
  return patterns.some((pattern) => {
    if (pattern === '*' || pattern === '**' || pattern === event) return true
    if (pattern.endsWith('.*')) return event.startsWith(`${pattern.slice(0, -1)}`)
    return false
  })
}

/** Where webhook subscriptions live. Default in-memory; back it with a DB in production. */
export interface WebhookStore {
  forEvent(event: string, tenantId?: string): Promise<WebhookEndpoint[]>
  add(endpoint: Omit<WebhookEndpoint, 'id'> & { id?: string }): Promise<WebhookEndpoint>
  /** Removes an endpoint. When `tenantId` is given, only if it owns the endpoint. */
  remove(id: string, tenantId?: string): Promise<void>
  list(tenantId?: string): Promise<WebhookEndpoint[]>
}

export class MemoryWebhookStore implements WebhookStore {
  private readonly endpoints = new Map<string, WebhookEndpoint>()

  async forEvent(event: string, tenantId?: string): Promise<WebhookEndpoint[]> {
    return [...this.endpoints.values()].filter(
      (endpoint) =>
        (endpoint.active ?? true) &&
        matchesEvent(endpoint.events, event) &&
        (tenantId === undefined || endpoint.tenantId === undefined || endpoint.tenantId === tenantId),
    )
  }

  async add(endpoint: Omit<WebhookEndpoint, 'id'> & { id?: string }): Promise<WebhookEndpoint> {
    const id = endpoint.id ?? randomUUID()
    const record: WebhookEndpoint = { ...endpoint, id }
    this.endpoints.set(id, record)
    return record
  }

  async remove(id: string, tenantId?: string): Promise<void> {
    if (tenantId !== undefined) {
      const existing = this.endpoints.get(id)
      if (!existing || existing.tenantId !== tenantId) return // not ours — no-op
    }
    this.endpoints.delete(id)
  }

  async list(tenantId?: string): Promise<WebhookEndpoint[]> {
    const all = [...this.endpoints.values()]
    return tenantId === undefined ? all : all.filter((endpoint) => endpoint.tenantId === tenantId)
  }
}
