import { describe, expect, it, vi } from 'vitest'
import { runWithContext, tryCtx } from '@basaltkit/core'
import {
  crossTenantScan,
  crossTenantScanSql,
  crossTenantSweep,
  type CrossTenantScanRow,
} from '../src/index.js'

const sql = (overrides: Partial<Parameters<typeof crossTenantScanSql>[0]> = {}): string =>
  crossTenantScanSql({
    name: 'stuck_jobs',
    table: 'jobs',
    tenantColumn: 'tenantId',
    columns: ['id'],
    where: `t."status" = 'PROCESSING'`,
    role: 'app',
    ...overrides,
  })

describe('crossTenantScanSql', () => {
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

  it('returns the declared identifier columns only, under fixed output names', () => {
    const out = sql({ columns: ['id', 'jobKey'] })
    expect(out).toContain('RETURNS TABLE ("tenant_id" text, "id" text, "jobKey" text)')
    expect(out).toContain('SELECT t."tenantId" AS "tenant_id", t."id" AS "id", t."jobKey" AS "jobKey"')
    expect(out).not.toContain('SELECT *')
  })

  it('locks execution down: drops PUBLIC, grants the app role only', () => {
    const out = sql({ role: ['app', 'worker'] })
    expect(out).toContain('REVOKE ALL ON FUNCTION "public"."stuck_jobs"(integer, text, text) FROM PUBLIC;')
    expect(out).toContain('GRANT EXECUTE ON FUNCTION "public"."stuck_jobs"(integer, text, text) TO "app";')
    expect(out).toContain('GRANT EXECUTE ON FUNCTION "public"."stuck_jobs"(integer, text, text) TO "worker";')
  })

  it('is idempotent (drops and recreates) and can hand the function to a privileged owner', () => {
    const out = sql({ owner: 'app_owner' })
    expect(out).toContain('DROP FUNCTION IF EXISTS "public"."stuck_jobs"(integer, text, text);')
    expect(out).toContain('ALTER FUNCTION "public"."stuck_jobs"(integer, text, text) OWNER TO "app_owner";')
    expect(sql()).not.toContain('OWNER TO')
  })

  it('caps the result and pages it with an ordered cursor', () => {
    const out = sql({ maxRows: 250 })
    expect(out).toContain('LIMIT least(greatest(coalesce(p_limit, 250), 1), 250)')
    expect(out).toContain('p_limit integer DEFAULT 250')
    expect(out).toContain('ORDER BY t."tenantId", t."id"')
    expect(out).toContain('(t."tenantId", t."id")')
    expect(out).toContain('> (p_after_tenant::text, p_after_id::text)')
  })

  it('casts the cursor to the declared column types, so ordering stays native', () => {
    const out = sql({ tenantType: 'text', columns: [{ name: 'id', type: 'uuid' }] })
    expect(out).toContain('> (p_after_tenant::text, p_after_id::uuid)')
    expect(out).toContain('RETURNS TABLE ("tenant_id" text, "id" uuid)')
  })

  it('quotes and validates every identifier', () => {
    expect(() => sql({ name: 'stuck jobs' })).toThrow(/Invalid function name/)
    expect(() => sql({ table: 'jobs; drop table users' })).toThrow(/Invalid table/)
    expect(() => sql({ tenantColumn: '"tenantId"' })).toThrow(/Invalid tenant column/)
    expect(() => sql({ columns: ['id--'] })).toThrow(/Invalid identifier column/)
    expect(() => sql({ role: 'app; --' })).toThrow(/Invalid role/)
    expect(() => sql({ schema: 'pg_catalog, evil' })).toThrow(/Invalid schema/)
    expect(() => sql({ columns: [{ name: 'id', type: 'text); drop' }] })).toThrow(/Invalid type of identifier/)
  })

  it('refuses a where clause that could escape the function body', () => {
    expect(() => sql({ where: `t."a" = 1; DROP TABLE jobs` })).toThrow(/semicolon/)
    expect(() => sql({ where: `t."a" = 1 -- comment` })).toThrow(/line comment/)
    expect(() => sql({ where: `t."a" = 1 /* c */` })).toThrow(/block comment/)
    expect(() => sql({ where: `t."a" = $basalt_cross_tenant_scan$x$basalt_cross_tenant_scan$` })).toThrow(/dollar sign/)
  })

  it('refuses a definition that would return more than identifiers', () => {
    expect(() => sql({ columns: [] })).toThrow(/at least the row identifier/)
    expect(() => sql({ columns: ['id', 'a', 'b', 'c', 'd'] })).toThrow(/identifiers only/)
    // the tenant column is already returned as tenant_id
    expect(() => sql({ columns: ['id', 'tenant_id'] })).toThrow(/duplicate returned column/)
    expect(() => sql({ columns: ['id', 'id'] })).toThrow(/duplicate returned column/)
  })

  it('validates maxRows', () => {
    expect(() => sql({ maxRows: 0 })).toThrow(/maxRows/)
    expect(() => sql({ maxRows: 2_000_000 })).toThrow(/maxRows/)
  })

  it('defaults where to true and the tenant column to tenant_id', () => {
    const out = crossTenantScanSql({ name: 'scan', table: 'jobs', columns: ['id'], role: 'app' })
    expect(out).toContain('WHERE (true)')
    expect(out).toContain('t."tenant_id" AS "tenant_id"')
  })

  it('warns, in the SQL itself, that the function bypasses RLS', () => {
    expect(sql()).toContain('DELIBERATELY BYPASSES row-level security')
  })
})

/** A client that records the raw query it was given and replays canned rows. */
const fakeClient = (rows: unknown[]) => {
  const calls: Array<{ query: string; values: unknown[] }> = []
  return {
    calls,
    $queryRawUnsafe: (query: string, ...values: unknown[]) => {
      calls.push({ query, values })
      return Promise.resolve(rows)
    },
  }
}

describe('crossTenantScan', () => {
  it('calls the function and maps the identifier rows', async () => {
    const client = fakeClient([
      { tenant_id: 'acme', id: 'j1' },
      { tenant_id: 'globex', id: 'j2' },
    ])
    const rows = await crossTenantScan(client, 'stuck_jobs', { limit: 50 })

    expect(client.calls[0]?.query).toBe('SELECT * FROM "public"."stuck_jobs"($1, $2, $3)')
    expect(client.calls[0]?.values).toEqual([50, null, null])
    expect(rows).toEqual([
      { tenantId: 'acme', id: 'j1' },
      { tenantId: 'globex', id: 'j2' },
    ])
  })

  it('passes the cursor as text and honours the schema', async () => {
    const client = fakeClient([])
    await crossTenantScan(client, 'stuck_jobs', { schema: 'ops', after: { tenantId: 'acme', id: 'j1' } })
    expect(client.calls[0]?.query).toBe('SELECT * FROM "ops"."stuck_jobs"($1, $2, $3)')
    expect(client.calls[0]?.values).toEqual([null, 'acme', 'j1'])
  })

  it('returns the extra identifier columns the caller declared', async () => {
    const client = fakeClient([{ tenant_id: 'acme', id: 'j1', jobKey: 'k1' }])
    const rows = await crossTenantScan(client, 'stuck_jobs', { columns: ['jobKey'] })
    expect(rows[0]).toEqual({ tenantId: 'acme', id: 'j1', jobKey: 'k1' })
  })

  it('refuses a function whose returned columns are not a subset of the declared ones', async () => {
    // The whole guarantee is "identifiers only": a function edited to also
    // select tenant data must not reach application code.
    const client = fakeClient([{ tenant_id: 'acme', id: 'j1', customer_email: 'a@b.c' }])
    await expect(crossTenantScan(client, 'stuck_jobs')).rejects.toMatchObject({
      code: 'PRISMA_CROSS_TENANT_SCAN_SHAPE',
    })
    await expect(crossTenantScan(client, 'stuck_jobs')).rejects.toThrow(/customer_email/)
  })

  it('refuses a row missing a declared column, or with a NULL identifier', async () => {
    await expect(
      crossTenantScan(fakeClient([{ tenant_id: 'acme', id: 'j1' }]), 'scan', { columns: ['jobKey'] }),
    ).rejects.toMatchObject({ code: 'PRISMA_CROSS_TENANT_SCAN_SHAPE' })
    await expect(
      crossTenantScan(fakeClient([{ tenant_id: null, id: 'j1' }]), 'scan'),
    ).rejects.toMatchObject({ code: 'PRISMA_CROSS_TENANT_SCAN_SHAPE' })
  })

  it('refuses to run inside a tenant context — a sweep is central code', async () => {
    const client = fakeClient([])
    await runWithContext({ tenant: { id: 'acme' } }, async () => {
      await expect(crossTenantScan(client, 'stuck_jobs')).rejects.toMatchObject({
        code: 'PRISMA_CROSS_TENANT_IN_TENANT',
      })
    })
    expect(client.calls).toHaveLength(0)
  })

  it('validates the function name and schema', async () => {
    await expect(crossTenantScan(fakeClient([]), 'stuck jobs')).rejects.toThrow(/Invalid function name/)
  })
})

/** Pages of identifier rows, served like the SQL function would. */
const pagedScan = (all: CrossTenantScanRow[]) => {
  const calls: Array<{ limit: number; after?: { tenantId: string; id: string } }> = []
  return {
    calls,
    scan: ({ limit, after }: { limit: number; after?: { tenantId: string; id: string } }) => {
      calls.push({ limit, ...(after ? { after } : {}) })
      const start = after
        ? all.findIndex((r) => r.tenantId === after.tenantId && r.id === after.id) + 1
        : 0
      return Promise.resolve(all.slice(start, start + limit))
    },
  }
}

const rows = (...pairs: Array<[string, string]>): CrossTenantScanRow[] =>
  pairs.map(([tenantId, id]) => ({ tenantId, id }))

describe('crossTenantSweep', () => {
  it('processes every item inside its own tenant context, grouped by tenant', async () => {
    const source = pagedScan(rows(['acme', 'j1'], ['acme', 'j2'], ['globex', 'j3']))
    const entered: string[] = []
    const seen: Array<[string, string]> = []

    const result = await crossTenantSweep({
      scan: source.scan,
      run: async (tenantId, fn) => {
        entered.push(tenantId)
        await runWithContext({ tenant: { id: tenantId } }, fn)
      },
      handle: (item) => {
        // the context tenant is the item's tenant — the scoped client would work here
        seen.push([(tryCtx()?.['tenant'] as { id: string }).id, item.id])
      },
    })

    expect(entered).toEqual(['acme', 'globex']) // one run per tenant, not per item
    expect(seen).toEqual([
      ['acme', 'j1'],
      ['acme', 'j2'],
      ['globex', 'j3'],
    ])
    expect(result).toMatchObject({ found: 3, processed: 3, failed: 0, tenants: 2, truncated: false })
  })

  it('puts the tenant in the context by default (no tenancy instance needed)', async () => {
    const seen: Array<string | undefined> = []
    await crossTenantSweep({
      scan: () => rows(['acme', 'j1']),
      handle: () => {
        seen.push((tryCtx()?.['tenant'] as { id: string } | undefined)?.id)
      },
    })
    expect(seen).toEqual(['acme'])
    expect(tryCtx()).toBeUndefined() // and the context does not leak out
  })

  it('pages with the cursor and stops on a short page', async () => {
    const source = pagedScan(rows(['acme', 'j1'], ['acme', 'j2'], ['globex', 'j3']))
    const result = await crossTenantSweep({ scan: source.scan, limit: 2, handle: () => {} })

    expect(source.calls).toEqual([
      { limit: 2 },
      { limit: 2, after: { tenantId: 'acme', id: 'j2' } },
    ])
    expect(result.pages).toBe(2)
    expect(result.cursor).toEqual({ tenantId: 'globex', id: 'j3' })
  })

  it('caps the sweep at maxItems so it cannot pull the whole table', async () => {
    const many = rows(...Array.from({ length: 50 }, (_, i) => ['acme', `j${i}`] as [string, string]))
    const source = pagedScan(many)
    const result = await crossTenantSweep({ scan: source.scan, limit: 10, maxItems: 25, handle: () => {} })

    expect(result.found).toBe(25)
    expect(result.truncated).toBe(true)
    expect(source.calls.at(-1)?.limit).toBe(5) // the last page is trimmed to the cap
  })

  it('isolates a failing item and reports it', async () => {
    const onError = vi.fn()
    const result = await crossTenantSweep({
      scan: () => rows(['acme', 'j1'], ['acme', 'j2']),
      onError,
      handle: (item) => {
        if (item.id === 'j1') throw new Error('boom')
      },
    })
    expect(result).toMatchObject({ processed: 1, failed: 1 })
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]?.[1]).toMatchObject({ id: 'j1' })
  })

  it('scans through the SQL function when given a client and a function name', async () => {
    const client = fakeClient([{ tenant_id: 'acme', id: 'j1' }])
    const result = await crossTenantSweep({ client, scanFunction: 'stuck_jobs', limit: 7, handle: () => {} })
    expect(client.calls[0]?.query).toBe('SELECT * FROM "public"."stuck_jobs"($1, $2, $3)')
    expect(client.calls[0]?.values).toEqual([7, null, null])
    expect(result.processed).toBe(1)
  })

  it('refuses to run inside a tenant context, and demands a source', async () => {
    await runWithContext({ tenant: { id: 'acme' } }, async () => {
      await expect(crossTenantSweep({ scan: () => [], handle: () => {} })).rejects.toMatchObject({
        code: 'PRISMA_CROSS_TENANT_IN_TENANT',
      })
    })
    await expect(crossTenantSweep({ handle: () => {} })).rejects.toThrow(/scanFunction|scan/)
  })
})
