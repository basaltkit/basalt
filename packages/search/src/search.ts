import { BasaltError, tryCtx } from '@basaltkit/core'
import { MemorySearchDriver } from './memory.js'
import type { SearchDocument, SearchDriver, SearchHit, SearchInput, SearchResult } from './types.js'

/** Search was asked for a tenant it couldn't determine. */
export class TenantRequiredError extends BasaltError {
  readonly status = 400
  constructor() {
    super('SEARCH_TENANT_REQUIRED', 'A tenant is required — pass tenantId or run inside a tenant context.')
  }
}

/**
 * The scope every document lands in when the app has no tenancy at all. The
 * driver contract is tenant-keyed, so a single-tenant app still needs one
 * stable key — it just shouldn't have to invent (and remember) it.
 */
export const SINGLE_TENANT_SCOPE = 'default'

/** Page size assumed when a caller with an `authorize` hook gives no `limit`. */
const DEFAULT_LIMIT = 10

export interface SearchOptions {
  /** Defaults to the current tenant (`ctx().tenant.id`). */
  tenantId?: string
  filters?: Record<string, unknown>
  limit?: number
  offset?: number
  /**
   * Row-level authorization, applied after the driver and before the page is
   * returned. Return the hits the caller may see, in the order given.
   *
   * A driver filters by the fields declared `filterable`, and nothing else. In
   * a product where visibility depends on a policy — a confidential matter is
   * visible only to the people assigned to it — that leaves search as the one
   * surface with no answer, and both ways around it are bad:
   *
   * - **Copy the ACL into the index** and filter there. Fast, and it makes the
   *   index a second copy of an access rule. Removing someone from a
   *   confidential matter changes the database and not the index, and search
   *   keeps showing it to them until somebody reindexes. A stale index gives an
   *   old result; a stale ACL gives an unauthorized one.
   * - **Over-fetch and trim afterwards.** Correct, but the over-fetch factor is
   *   a guess, and a caller with little access gets short pages.
   *
   * With the hook here, the package keeps asking the driver until the page is
   * full or the index runs out — which the caller cannot do from outside.
   *
   * The hook must not reorder: relevance is the driver's to decide.
   */
  authorize?: (hits: SearchHit[]) => SearchHit[] | Promise<SearchHit[]>
  /**
   * How many driver rows an authorized search may scan before giving up.
   * Default: 20 pages' worth, floor 200.
   *
   * A hook that authorizes almost nothing would otherwise walk the whole index
   * on every keystroke. Reaching the budget is reported as `totalExact: false`
   * rather than as an error: a short page is a worse answer than a slow one,
   * and a wrong count is worse than both.
   */
  maxScan?: number
}

/**
 * Tenant-scoped full-text search. Indexing takes the tenant from the document;
 * querying takes it from `options.tenantId` or the current request context.
 */
/**
 * What `search.reindex()` needs from a sync rule. Structural, so `search.ts`
 * does not import the plugin that owns the rule type.
 */
export interface ReindexableRule {
  index: string
  document?: (payload: never) => SearchInput | null
  backfill?: () => AsyncIterable<never[]>
}

export class Search {
  private readonly driver: SearchDriver
  private readonly rules: ReindexableRule[]

  constructor(
    options: { driver?: SearchDriver; rules?: ReindexableRule[] } = {},
    /**
     * Whether the host app registered `@basaltkit/tenancy`. `searchPlugin`
     * wires this to the container's `'tenancy:active'` metadata marker — a
     * signal, not an import, so this generic package never depends on the
     * opt-in SaaS layer. Defaults to `false` (single-tenant).
     */
    private readonly tenancyActive: () => boolean = () => false,
  ) {
    this.driver = options.driver ?? new MemorySearchDriver()
    this.rules = options.rules ?? []
  }

  index(indexName: string, document: SearchInput): Promise<void> {
    return this.driver.index(indexName, this.resolveDocument(document))
  }

  bulk(indexName: string, documents: SearchInput[]): Promise<void> {
    return this.driver.bulk(indexName, documents.map((document) => this.resolveDocument(document)))
  }

  async remove(indexName: string, id: string, tenantId?: string): Promise<void> {
    return this.driver.remove(indexName, this.tenant(tenantId), id)
  }

  async search(indexName: string, q: string, options: SearchOptions = {}): Promise<SearchResult> {
    const tenantId = this.tenant(options.tenantId)
    const base = {
      tenantId,
      q,
      ...(options.filters ? { filters: options.filters } : {}),
    }

    // No hook: one call, exactly as before. The option must cost nothing to
    // everyone who does not use it.
    if (!options.authorize) {
      return this.driver.search(indexName, {
        ...base,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
      })
    }

    const limit = options.limit ?? DEFAULT_LIMIT
    const offset = options.offset ?? 0
    // `offset` counts AUTHORIZED hits, not driver rows: page two has to
    // continue where page one ended, and skipping driver rows would skip
    // results the caller never saw.
    const wanted = offset + limit
    const budget = options.maxScan ?? Math.max(wanted * 20, 200)
    const batch = Math.max(limit, 10)

    const authorized: SearchHit[] = []
    let scanned = 0
    let exhausted = false

    while (authorized.length < wanted && scanned < budget) {
      const take = Math.min(batch, budget - scanned)
      const page = await this.driver.search(indexName, { ...base, limit: take, offset: scanned })
      scanned += take
      if (page.hits.length === 0) {
        exhausted = true
        break
      }
      authorized.push(...(await options.authorize(page.hits)))
      if (page.hits.length < take) {
        exhausted = true
        break
      }
    }

    return {
      hits: authorized.slice(offset, offset + limit),
      // The driver's total counts rows the caller may not see; rendering it
      // would put "42 results" above three rows. This is the authorized count,
      // and it is only the whole truth when the scan reached the end.
      total: authorized.length,
      totalExact: exhausted,
    }
  }

  /**
   * Rebuilds an index from the rules that keep it current.
   *
   * A rule fed by events knows only what was created after it existed, so an
   * application adding search to data it already has gets a box that returns
   * nothing for everything old — and an empty result is indistinguishable from
   * "there is none".
   *
   * The rebuild goes through the rule's own `document`, so a record cannot be
   * described one way when it is created and another way when it is rebuilt.
   * That drift is quiet and nasty: the same search returns different things
   * depending on whether a record predates the last rebuild.
   *
   * Returns how many documents were written.
   */
  async reindex(indexName: string): Promise<number> {
    const declared = this.rules.filter((rule) => rule.index === indexName)
    if (declared.length === 0) {
      throw new Error(
        `No sync rule declares the index "${indexName}", so there is nothing to rebuild it from.`,
      )
    }
    const rebuildable = declared.filter((rule) => rule.backfill && rule.document)
    if (rebuildable.length === 0) {
      throw new Error(
        `The rules for index "${indexName}" have no \`backfill\`, so it cannot be rebuilt. ` +
          'Add one to the rule that indexes those records — it yields pages of the same hook ' +
          'payload the rule already maps, so one `document` function serves both directions.',
      )
    }

    // Cleared first: a rebuild that appends leaves documents for records that
    // no longer exist, which is the state a rebuild exists to end.
    await this.driver.clear(indexName)

    let written = 0
    for (const rule of rebuildable) {
      for await (const page of rule.backfill!()) {
        const documents = page
          .map((payload) => rule.document!(payload))
          .filter((document): document is SearchInput => document !== null)
          .map((document) => this.resolveDocument(document))
        if (documents.length === 0) continue
        await this.driver.bulk(indexName, documents)
        written += documents.length
      }
    }
    return written
  }

  /**
   * The tenant a call is scoped to.
   *
   * With `@basaltkit/tenancy` registered an unresolvable tenant is an error:
   * indexing or querying unscoped would cross tenants. Without it there is no
   * tenant dimension, so every document shares {@link SINGLE_TENANT_SCOPE} and
   * index/query always agree.
   */
  private tenant(explicit?: string): string {
    const id = explicit ?? (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    if (id) return id
    if (this.tenancyActive()) throw new TenantRequiredError()
    return SINGLE_TENANT_SCOPE
  }

  /** Fills in the document's tenant with the same rule the read path uses. */
  private resolveDocument(document: SearchInput): SearchDocument {
    return { ...document, tenantId: this.tenant(document.tenantId) }
  }
}
