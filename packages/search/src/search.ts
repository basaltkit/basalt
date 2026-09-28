import { BasaltError, tryCtx } from '@basaltkit/core'
import { MemorySearchDriver } from './memory.js'
import type { IndexDefinition, SearchDocument, SearchDriver, SearchHit, SearchInput, SearchResult } from './types.js'

/** Search was asked for a tenant it couldn't determine. */
export class TenantRequiredError extends BasaltError {
  readonly status = 400
  constructor(message = 'A tenant is required — pass tenantId or run inside a tenant context.') {
    super('SEARCH_TENANT_REQUIRED', message)
  }
}

/**
 * `limit`/`offset` that is not a non-negative integer, or a `limit` above the
 * configured `maxLimit`. Both usually arrive from a query string, so they are
 * checked here once rather than left to each engine to reject (or not).
 */
export class SearchPaginationError extends BasaltError {
  readonly status = 400
  constructor(message: string) {
    super('SEARCH_INVALID_PAGINATION', message)
  }
}

/**
 * A filter on a field the index did not declare `filterable`. Letting any
 * stored field be filtered turns search into an oracle for values the index
 * holds but never meant to expose ("does anyone earn 90000?").
 */
export class SearchFilterNotFilterableError extends BasaltError {
  readonly status = 400
  constructor(index: string, field: string) {
    super('SEARCH_FILTER_NOT_FILTERABLE', `Field ${JSON.stringify(field)} is not declared filterable on index ${JSON.stringify(index)}.`)
  }
}

/**
 * A filter value that is not a string, a finite number or a boolean (or a
 * non-nested array of those). `null`/`undefined` are refused too: dropping the
 * filter would silently widen the result — `{ ownerId: user?.id }` with no user
 * would return everyone's rows — and every engine reads them differently.
 */
export class SearchFilterValueError extends BasaltError {
  readonly status = 400
  constructor(field: string) {
    super(
      'SEARCH_INVALID_FILTER_VALUE',
      `Filter ${JSON.stringify(field)} must be a string, a finite number, a boolean, or an array of those.`,
    )
  }
}

/** Whether a filter value is one every driver compares the same way. */
export function isFilterScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

/** Throw {@link SearchFilterValueError} unless `value` is a scalar or a flat array of scalars. */
export function assertFilterValue(field: string, value: unknown): void {
  const ok = Array.isArray(value) ? value.every(isFilterScalar) : isFilterScalar(value)
  if (!ok) throw new SearchFilterValueError(field)
}

/**
 * An explicit `tenantId` named a different tenant than the one the call runs
 * in. The context tenant is authoritative; an argument may narrow to it, never
 * widen past it.
 */
export class SearchTenantMismatchError extends BasaltError {
  readonly status = 403
  constructor() {
    super('SEARCH_TENANT_MISMATCH', 'The tenantId does not match the current tenant.')
  }
}

/**
 * A tenant id equal to {@link SINGLE_TENANT_SCOPE}. That string is the scope of
 * a single-tenant app's documents, so a tenant carrying it would find, plant
 * and remove them. The default tenancy grammar can never produce it; a custom
 * one that does must pick another id.
 */
export class SearchTenantReservedError extends BasaltError {
  readonly status = 400
  constructor() {
    super('SEARCH_TENANT_RESERVED', `"${SINGLE_TENANT_SCOPE}" is reserved for single-tenant documents and cannot be a tenant id.`)
  }
}

/**
 * The scope every document lands in when the app has no tenancy at all. The
 * driver contract is tenant-keyed, so a single-tenant app still needs one
 * stable key — it just shouldn't have to invent (and remember) it.
 *
 * A sentinel no tenant id can equal: `@` is outside `@basaltkit/tenancy`'s
 * grammar, and a context, explicit or document tenant carrying it is refused
 * with {@link SearchTenantReservedError}. It used to be `'default'` — a
 * perfectly valid tenant id, so a tenant named `default` found (and could
 * remove or overwrite) the single-tenant documents. Documents indexed under
 * `'default'` by a single-tenant app must be re-keyed or reindexed once (see
 * the changelog for the migration).
 */
export const SINGLE_TENANT_SCOPE = '@single'

/** Page size assumed when a caller with an `authorize` hook gives no `limit`. */
const DEFAULT_LIMIT = 10

/** Largest `limit` a single search may ask for unless `maxLimit` says otherwise. */
export const DEFAULT_MAX_LIMIT = 1000

export interface SearchOptions {
  /**
   * Defaults to the current tenant (`ctx().tenant.id`). Inside a tenant
   * context it must name that tenant — any other value throws
   * {@link SearchTenantMismatchError}; it only selects a tenant outside one.
   */
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

export interface SearchServiceOptions {
  driver?: SearchDriver
  rules?: ReindexableRule[]
  /**
   * The index definitions. When an index is listed here, `filters` may only
   * name its `filterable` fields (and `tenantId`); an index not listed keeps
   * the old behaviour and passes any field to the driver. `searchPlugin`
   * forwards its `indexes`.
   */
  indexes?: IndexDefinition[]
  /** Largest `limit` a search may ask for. Default {@link DEFAULT_MAX_LIMIT}. */
  maxLimit?: number
}

export class Search {
  private readonly driver: SearchDriver
  private readonly rules: ReindexableRule[]
  private readonly definitions: Map<string, IndexDefinition>
  private readonly maxLimit: number

  constructor(
    options: SearchServiceOptions = {},
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
    this.definitions = new Map((options.indexes ?? []).map((index) => [index.name, index]))
    this.maxLimit = options.maxLimit ?? DEFAULT_MAX_LIMIT
    if (!Number.isInteger(this.maxLimit) || this.maxLimit < 1) {
      throw new Error(`Search: maxLimit must be a positive integer, got ${String(options.maxLimit)}.`)
    }
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
    this.validatePagination(options)
    this.validateFilters(indexName, options.filters)
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

    // Every row is mapped and validated BEFORE anything is cleared: a rebuild
    // that fails half-way must leave the old index, not an empty one. This
    // walks the backfill twice rather than buffering it — memory stays bounded
    // by a page — and the second walk re-validates, so rows that changed in
    // between can still fail it (after the clear); rerun `reindex()` then.
    for (const rule of rebuildable) {
      for await (const page of rule.backfill!()) this.rebuildDocuments(indexName, rule, page)
    }

    // Then cleared, not appended to: a rebuild that appends leaves documents for records that
    // no longer exist, which is the state a rebuild exists to end.
    await this.driver.clear(indexName)

    let written = 0
    for (const rule of rebuildable) {
      for await (const page of rule.backfill!()) {
        const documents = this.rebuildDocuments(indexName, rule, page)
        if (documents.length === 0) continue
        await this.driver.bulk(indexName, documents)
        written += documents.length
      }
    }
    return written
  }

  /**
   * Maps one backfill page to driver documents.
   *
   * A rebuild is a system operation over every tenant, so the tenant comes from
   * the rule's own mapping — never from the context the rebuild happens to run
   * in. A row without one is refused whenever a tenant could exist (tenancy
   * registered, or a context tenant present): filing it under the caller's
   * tenant is how `reindex()` from inside `acme` used to hand `acme` every
   * other tenant's records. Only a single-tenant app with no context tenant
   * files tenant-less rows under {@link SINGLE_TENANT_SCOPE}.
   */
  private rebuildDocuments(indexName: string, rule: ReindexableRule, page: never[]): SearchDocument[] {
    const tenantKnowable = this.tenancyActive() || Boolean((tryCtx()?.['tenant'] as { id?: string } | undefined)?.id)
    const documents: SearchDocument[] = []
    for (const payload of page) {
      const document = rule.document!(payload)
      if (document === null) continue
      if (document.tenantId) {
        documents.push({ ...document, tenantId: assertNotReserved(document.tenantId) })
      } else if (tenantKnowable) {
        throw new TenantRequiredError(
          `reindex("${indexName}"): the rule mapped record ${JSON.stringify(document.id)} without a tenantId. ` +
            'A rebuild covers every tenant, so it cannot take the tenant from the current context — ' +
            'return tenantId from the rule\'s `document`.',
        )
      } else {
        documents.push({ ...document, tenantId: SINGLE_TENANT_SCOPE })
      }
    }
    return documents
  }

  private validatePagination(options: SearchOptions): void {
    const check = (name: 'limit' | 'offset', value: unknown): void => {
      if (value === undefined) return
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new SearchPaginationError(`${name} must be a non-negative integer, got ${JSON.stringify(value)}.`)
      }
    }
    check('limit', options.limit)
    check('offset', options.offset)
    if (options.limit !== undefined && options.limit > this.maxLimit) {
      throw new SearchPaginationError(`limit ${options.limit} exceeds the maximum of ${this.maxLimit}.`)
    }
  }

  private validateFilters(indexName: string, filters: Record<string, unknown> | undefined): void {
    if (!filters) return
    const definition = this.definitions.get(indexName)
    for (const [field, value] of Object.entries(filters)) {
      if (definition && field !== 'tenantId' && !(definition.filterable ?? []).includes(field)) {
        throw new SearchFilterNotFilterableError(indexName, field)
      }
      assertFilterValue(field, value)
    }
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
    // The context tenant wins: an explicit value is only honoured when it
    // agrees with it, or when there is no context tenant (jobs, CLI, scripts).
    // Letting the argument override the context let a caller that forwards
    // client input (`?tenantId=`) search, plant or remove another tenant's
    // documents.
    const ambient = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    if (ambient) {
      if (explicit !== undefined && explicit !== ambient) throw new SearchTenantMismatchError()
      return assertNotReserved(ambient)
    }
    if (explicit) return assertNotReserved(explicit)
    if (this.tenancyActive()) throw new TenantRequiredError()
    return SINGLE_TENANT_SCOPE
  }

  /** Fills in the document's tenant with the same rule the read path uses. */
  private resolveDocument(document: SearchInput): SearchDocument {
    return { ...document, tenantId: this.tenant(document.tenantId) }
  }
}

function assertNotReserved(tenantId: string): string {
  if (tenantId === SINGLE_TENANT_SCOPE) throw new SearchTenantReservedError()
  return tenantId
}
