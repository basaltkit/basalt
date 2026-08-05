import type { Container } from './container.js'
import { createToken } from './token.js'

/**
 * Central registry of what each plugin declared (routes, commands, schedules…).
 * Plugins write to named buckets at boot; tooling (CLI, docs generator,
 * dashboard) reads from them without importing the producing package.
 */
export class MetadataRegistry {
  private readonly entries = new Map<string, unknown[]>()

  add(bucket: string, entry: unknown): void {
    const list = this.entries.get(bucket) ?? []
    list.push(entry)
    this.entries.set(bucket, list)
  }

  get<T = unknown>(bucket: string): T[] {
    return [...((this.entries.get(bucket) as T[] | undefined) ?? [])]
  }

  bucketNames(): string[] {
    return [...this.entries.keys()]
  }
}

export const METADATA = createToken<MetadataRegistry>('metadata')

/** Returns the container's MetadataRegistry, registering one if absent. */
export function ensureMetadata(container: Container): MetadataRegistry {
  if (!container.has(METADATA)) {
    container.singleton(METADATA, () => new MetadataRegistry())
  }
  return container.get(METADATA)
}
