import { createToken, definePlugin } from '@basaltkit/core'
import type { BasaltHooks } from '@basaltkit/core'
import { MemorySearchDriver } from './memory.js'
import { Search } from './search.js'
import type { IndexDefinition, SearchDocument, SearchDriver } from './types.js'

export const SEARCH = createToken<Search>('search')

/**
 * Keeps an index in sync with domain events: on the given hook, either upsert a
 * document or remove one. Wire it once and your search index maintains itself.
 *
 *   syncRule({ hook: 'note:created', index: 'notes', document: (p) => ({
 *     id: p.note.id, tenantId: p.tenantId, title: p.note.title, body: p.note.body,
 *   })})
 */
export interface SyncRule<K extends keyof BasaltHooks & string = keyof BasaltHooks & string> {
  hook: K
  index: string
  /** Build the document to upsert. Return null to skip. */
  document?: (payload: BasaltHooks[K]) => SearchDocument | null
  /** Or the identifiers to remove. Return null to skip. */
  remove?: (payload: BasaltHooks[K]) => { tenantId: string; id: string } | null
}

/** Type-checks a sync rule against its hook, then erases the generic. */
export function syncRule<K extends keyof BasaltHooks & string>(rule: SyncRule<K>): SyncRule {
  return rule as unknown as SyncRule
}

export interface SearchPluginOptions {
  driver?: SearchDriver
  /** Indexes to register with the driver at boot. */
  indexes?: IndexDefinition[]
  /** Rules keeping indexes in sync with domain hooks. */
  sync?: SyncRule[]
}

export function searchPlugin(options: SearchPluginOptions = {}) {
  const driver = options.driver ?? new MemorySearchDriver()
  return definePlugin({
    name: 'basalt:search',
    register({ container }) {
      container.singleton(SEARCH, () => new Search({ driver }))
    },
    async boot({ container, hooks }) {
      const search = container.get(SEARCH)

      if (driver.register) {
        for (const index of options.indexes ?? []) await driver.register(index)
      }

      for (const rule of options.sync ?? []) {
        hooks.on(rule.hook, async (payload) => {
          if (rule.document) {
            const document = rule.document(payload)
            if (document) await search.index(rule.index, document)
          } else if (rule.remove) {
            const target = rule.remove(payload)
            if (target) await search.remove(rule.index, target.id, target.tenantId)
          }
        })
      }
    },
  })
}
