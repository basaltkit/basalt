/** Cache driver contract. Every driver passes the same conformance suite. */
export interface CacheDriver {
  /** Returns the value, or undefined on miss/expired. */
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, ttlMs?: number, tags?: string[]): Promise<void>
  delete(key: string): Promise<boolean>
  /** Removes all keys starting with the prefix. */
  flushPrefix(prefix: string): Promise<void>
  /** Removes all keys associated with any of the tags. */
  flushTags(tags: string[]): Promise<void>
  disconnect(): Promise<void>
}
