import { createToken, definePlugin, ensureMetadata } from '@basaltkit/core'
import type { BasaltHooks } from '@basaltkit/core'
import { MemorySearchDriver } from './memory.js'
import { Search } from './search.js'
import type { IndexDefinition, SearchDriver, SearchInput } from './types.js'

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
  document?: (payload: BasaltHooks[K]) => SearchInput | null
  /** Or the identifiers to remove. Return null to skip. */
  remove?: (payload: BasaltHooks[K]) => { tenantId?: string; id: string } | null
  /**
   * Every record this rule would ever index, in pages, for `search.reindex()`.
   *
   * A rule fed by events keeps an index current from the moment it exists and
   * does nothing for the rows already in the database — so an application that
   * adds search to existing data gets a box that returns nothing for everything
   * old, and an empty result is indistinguishable from "there is none".
   *
   * It yields **hook payloads**, not rows, so the same `document` function
   * serves both directions. A second mapping written by hand is the drift this
   * prevents: let it disagree with `document` and the same search returns
   * different things depending on whether a record predates the last rebuild.
   */
  backfill?: () => AsyncIterable<BasaltHooks[K][]>
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
  /**
   * Throw if an index fails to register at boot. Default `false`: a search
   * backend that's down or misconfigured logs a warning and the app boots
   * anyway (search stays degraded until the backend is reachable), so an outage
   * never blocks unrelated work — including CLI commands that don't use search.
   */
  failOnRegisterError?: boolean
}

export function searchPlugin(options: SearchPluginOptions = {}) {
  const driver = options.driver ?? new MemorySearchDriver()
  return definePlugin({
    name: 'basalt:search',
    register({ container }) {
      // 'tenancy:active' is tenancyPlugin's marker: how a generic package
      // learns the app is multi-tenant without importing @basaltkit/tenancy.
      const metadata = ensureMetadata(container)
      // The rules go to the service so `reindex()` can rebuild an index from
      // the same declaration that keeps it current.
      container.singleton(
        SEARCH,
        () =>
          new Search(
            { driver, rules: (options.sync ?? []) as never },
            () => metadata.get('tenancy:active').length > 0,
          ),
      )
    },
    async boot({ container, hooks }) {
      const search = container.get(SEARCH)

      if (driver.register) {
        for (const index of options.indexes ?? []) {
          try {
            await driver.register(index)
          } catch (error) {
            if (options.failOnRegisterError) throw error
            // Non-fatal by default: a search backend that's down/misconfigured
            // shouldn't stop the app booting or block unrelated CLI commands.
            console.warn(
              `[basalt:search] could not register index "${index.name}": ${String(
                (error as { message?: string })?.message ?? error,
              )} — search is degraded until the backend is reachable.`,
            )
          }
        }
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
