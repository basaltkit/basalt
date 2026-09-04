/**
 * An id for a record the caller did not name.
 *
 * NOT `node:crypto`. This package is the engine two React bindings render, so
 * its destination is the browser; a Node builtin here fails the bundler
 * outright, and every consuming app had to alias it away.
 *
 * NOT `crypto.randomUUID()` on its own either. That needs a **secure context**
 * and is undefined on plain http — which is exactly how a developer reaches a
 * dev server from a phone on the local network. Swapping one unavailable API
 * for another moves the failure instead of fixing it.
 *
 * So: the real thing where it exists, and a counter where it does not. This is
 * an in-memory source for development and tests — ids have to be unique within
 * one process, and nothing more. Anything durable brings its own.
 */
let contador = 0
const novoId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `mem-${Date.now().toString(36)}-${(contador += 1)}`

export interface ListParams {
  page?: number
  pageSize?: number
  /** Free-text search across string fields. */
  search?: string
}

/**
 * The data contract an admin UI drives. Implement it over the @basaltkit/sdk
 * client for a real backend, or use memoryDataSource for tests and demos.
 */
export interface AdminDataSource<T = Record<string, unknown>> {
  list(params?: ListParams): Promise<T[]>
  get(id: string): Promise<T | null>
  create(input: Record<string, unknown>): Promise<T>
  update(id: string, input: Record<string, unknown>): Promise<T | null>
  remove(id: string): Promise<boolean>
}

/** In-memory data source — tests, demos and local prototyping. */
export function memoryDataSource<T extends { id: string }>(seed: T[] = []): AdminDataSource<T> {
  const items = new Map<string, T>(seed.map((item) => [item.id, item]))

  return {
    async list(params) {
      let rows = [...items.values()]
      if (params?.search) {
        const needle = params.search.toLowerCase()
        rows = rows.filter((row) =>
          Object.values(row as Record<string, unknown>).some(
            (value) => typeof value === 'string' && value.toLowerCase().includes(needle),
          ),
        )
      }
      const page = Math.max(1, params?.page ?? 1)
      const size = params?.pageSize ?? rows.length
      return rows.slice((page - 1) * size, (page - 1) * size + size)
    },
    async get(id) {
      return items.get(id) ?? null
    },
    async create(input) {
      const id = typeof input['id'] === 'string' ? (input['id'] as string) : novoId()
      const item = { ...input, id } as T
      items.set(id, item)
      return item
    },
    async update(id, input) {
      const existing = items.get(id)
      if (!existing) return null
      const updated = { ...existing, ...input, id } as T
      items.set(id, updated)
      return updated
    },
    async remove(id) {
      return items.delete(id)
    },
  }
}
