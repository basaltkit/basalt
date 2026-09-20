import { describe, expect, it } from 'vitest'
import { rlsPolicySql, rlsSearchFunctionSql } from '../src/index.js'

const sql = (overrides: Partial<Parameters<typeof rlsSearchFunctionSql>[0]> = {}): string =>
  rlsSearchFunctionSql({
    name: 'basalt_search_scoped',
    table: 'basalt_search',
    vectorColumn: 'tsv',
    partitionColumn: 'idx',
    filterColumn: 'document',
    columns: [{ name: 'document', type: 'jsonb' }],
    role: 'app',
    ...overrides,
  })

/** The same function with no partition and no filter column configured. */
const bare = (): string =>
  rlsSearchFunctionSql({
    name: 'basalt_search_scoped',
    table: 'basalt_search',
    vectorColumn: 'tsv',
    role: 'app',
  })

describe('rlsSearchFunctionSql', () => {
  it('generates a SECURITY DEFINER function with a pinned search_path', () => {
    const out = sql()
    expect(out).toContain('SECURITY DEFINER')
    // A SECURITY DEFINER function without a pinned search_path is a
    // privilege-escalation hole.
    expect(out).toContain('SET search_path = pg_catalog, "public"')
    expect(out).toContain('LANGUAGE sql')
    expect(out).toContain('STABLE')
    expect(out).toContain('PARALLEL SAFE')
  })

  it('takes NO tenant parameter — the tenant can only come from the setting', () => {
    const out = sql()
    expect(out).toContain('CREATE FUNCTION "public"."basalt_search_scoped"(\n  p_query text,')
    expect(out).toContain('DROP FUNCTION IF EXISTS "public"."basalt_search_scoped"(text, text, jsonb, integer, integer);')
    // nothing in the parameter list even hints at a tenant
    const params = out.slice(out.indexOf('CREATE FUNCTION'), out.indexOf('RETURNS TABLE'))
    expect(params).not.toMatch(/tenant/i)
  })

  it('scopes with the same predicate rlsPolicySql puts in the policy', () => {
    const predicate = `= current_setting('app.tenant_id', true)`
    expect(sql()).toContain(`WHERE t."tenant_id" ${predicate}`)
    expect(rlsPolicySql({ tables: ['basalt_search'] })).toContain(`"tenant_id" ${predicate}`)
  })

  it('fails closed: an unset setting reads as NULL, so the predicate matches nothing', () => {
    // `current_setting(…, true)` — the `true` is what turns "unset" into NULL
    // instead of an error, and `col = NULL` is never true.
    expect(sql()).toContain(`current_setting('app.tenant_id', true)`)
    expect(sql()).not.toContain(`current_setting('app.tenant_id')`)
  })

  it('carries a custom setting through, and refuses one that is not namespaced', () => {
    expect(sql({ setting: 'basalt.tenant' })).toContain(`current_setting('basalt.tenant', true)`)
    expect(() => sql({ setting: 'tenant' })).toThrow(/namespaced GUC/)
  })

  it('always returns the tenant id, so a caller can verify what it got', () => {
    const out = sql()
    expect(out).toContain('RETURNS TABLE ("tenant_id" text, "id" text, "document" jsonb, "score" real, "total" bigint)')
    expect(out).toContain('t."tenant_id" AS "tenant_id"')
  })

  it('keeps the tsvector match as its own qualifier over the indexed column', () => {
    const out = sql()
    expect(out).toContain('t."tsv" @@ (SELECT "q" FROM "basalt_tsquery")')
    expect(out).toContain(`plainto_tsquery('english'::regconfig, p_query)`)
  })

  it('supports the other tsquery parsers and refuses an unknown one', () => {
    expect(sql({ parser: 'websearch' })).toContain('websearch_to_tsquery(')
    expect(sql({ parser: 'phraseto' })).toContain('phraseto_tsquery(')
    expect(sql({ parser: 'raw' })).toContain('to_tsquery(')
    expect(() => sql({ parser: 'sql' as never })).toThrow(/Invalid parser/)
  })

  it('carries the text-search configuration and refuses a bogus one', () => {
    expect(sql({ language: 'portuguese' })).toContain(`'portuguese'::regconfig`)
    expect(() => sql({ language: `english'); DROP TABLE x --` })).toThrow(/text-search configuration/)
  })

  it('locks execution down: drops PUBLIC, grants the app role only', () => {
    const out = sql({ role: ['app', 'worker'] })
    // A new function is EXECUTE-able by PUBLIC by default.
    expect(out).toContain('REVOKE ALL ON FUNCTION "public"."basalt_search_scoped"(text, text, jsonb, integer, integer) FROM PUBLIC;')
    expect(out).toContain('GRANT EXECUTE ON FUNCTION "public"."basalt_search_scoped"(text, text, jsonb, integer, integer) TO "app";')
    expect(out).toContain('GRANT EXECUTE ON FUNCTION "public"."basalt_search_scoped"(text, text, jsonb, integer, integer) TO "worker";')
  })

  it('assigns the owner when one is given — it is the role the function RUNS as', () => {
    expect(sql({ owner: 'app_owner' })).toContain(
      'ALTER FUNCTION "public"."basalt_search_scoped"(text, text, jsonb, integer, integer) OWNER TO "app_owner";',
    )
    expect(sql()).not.toContain('OWNER TO')
  })

  it('caps the rows one call may return', () => {
    expect(sql()).toContain('LIMIT least(greatest(coalesce(p_limit, 100), 0), 100)')
    expect(sql({ maxRows: 50 })).toContain('LIMIT least(greatest(coalesce(p_limit, 50), 0), 50)')
    expect(() => sql({ maxRows: 0 })).toThrow(/maxRows/)
    expect(() => sql({ maxRows: 100_000 })).toThrow(/maxRows/)
  })

  it('reports the pre-LIMIT match count so a caller can page', () => {
    expect(sql()).toContain('count(*) OVER () AS "total"')
    expect(sql()).toContain('OFFSET greatest(coalesce(p_offset, 0), 0)')
  })

  it('orders by rank, then by the id column, so paging is deterministic', () => {
    expect(sql({ idColumn: 'docId' })).toContain('ORDER BY "score" DESC, t."docId"')
  })

  it('applies the partition filter only when one is configured', () => {
    expect(sql()).toContain('(p_partition IS NULL OR t."idx" = p_partition)')
    // no partition column: a partition argument can only match nothing
    expect(bare()).toContain('AND (p_partition IS NULL)')
  })

  it('never silently drops filters: no filter column means a non-NULL p_filters matches nothing', () => {
    const withFilters = sql()
    expect(withFilters).toContain(`t."document"->>f."key" = (f."value" #>> '{}')`)
    expect(withFilters).toContain('jsonb_array_elements_text(f."value")')
    const without = bare()
    expect(without).toContain('AND (p_filters IS NULL)')
    expect(without).not.toContain('jsonb_each(p_filters)')
  })

  it('warns, in the SQL itself, against the LEAKPROOF shortcut', () => {
    expect(sql()).toContain('LEAKPROOF')
    expect(sql()).toMatch(/Do NOT "fix" the plan with ALTER FUNCTION \.\.\. LEAKPROOF/)
  })

  it('validates and quotes every identifier', () => {
    expect(() => sql({ name: 'bad name' })).toThrow(/Invalid function name/)
    expect(() => sql({ table: 'jobs; DROP TABLE users' })).toThrow(/Invalid table/)
    expect(() => sql({ vectorColumn: 'tsv"' })).toThrow(/Invalid tsvector column/)
    expect(() => sql({ tenantColumn: '1tenant' })).toThrow(/Invalid tenant column/)
    expect(() => sql({ schema: 'pub-lic' })).toThrow(/Invalid schema/)
    expect(() => sql({ role: 'app role' })).toThrow(/Invalid role/)
    expect(() => sql({ owner: 'own;er' })).toThrow(/Invalid owner role/)
    expect(() => sql({ partitionColumn: 'i dx' })).toThrow(/Invalid partition column/)
    expect(() => sql({ filterColumn: 'doc(ument)' })).toThrow(/Invalid filter column/)
    expect(() => sql({ columns: [{ name: 'document', type: 'jsonb); DROP' }] })).toThrow(/plain SQL type name/)
  })

  it('refuses payload columns that collide with what the function always returns', () => {
    expect(() => sql({ columns: ['score'] })).toThrow(/reserved/)
    expect(() => sql({ columns: ['total'] })).toThrow(/reserved/)
    expect(() => sql({ columns: ['tenant_id'] })).toThrow(/reserved/)
    expect(() => sql({ columns: ['title', 'title'] })).toThrow(/duplicate payload column/)
    expect(() => sql({ columns: Array.from({ length: 13 }, (_, i) => `c${i}`) })).toThrow(/max 12/)
  })

  it('returns tenant data on purpose — unlike a cross-tenant scan, it is tenant-scoped', () => {
    const out = sql({ columns: ['title', { name: 'body', type: 'text' }, { name: 'document', type: 'jsonb' }] })
    expect(out).toContain('t."title" AS "title", t."body" AS "body", t."document" AS "document"')
    expect(out).toContain('"title" text, "body" text, "document" jsonb')
  })

  it('is idempotent — drop then create, like rlsPolicySql', () => {
    const out = sql()
    expect(out.indexOf('DROP FUNCTION IF EXISTS')).toBeLessThan(out.indexOf('CREATE FUNCTION'))
  })
})
