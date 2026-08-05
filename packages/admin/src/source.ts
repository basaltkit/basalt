import { randomUUID } from 'node:crypto'

export interface ListParams {
  page?: number
  pageSize?: number
  /** Free-text search across string fields. */
  search?: string
}

/**
 * The data contract an admin UI drives. Implement it over the @machize/sdk
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
      const id = typeof input['id'] === 'string' ? (input['id'] as string) : randomUUID()
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
