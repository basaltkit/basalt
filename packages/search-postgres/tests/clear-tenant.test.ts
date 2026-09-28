import { describe, expect, it } from 'vitest'
import { Search } from '@basaltkit/search'
import { PostgresSearchDriver, type PgClientLike } from '../src/index.js'

/**
 * A stand-in for the one table the driver keeps, interpreting exactly the
 * statements it issues — enough to watch rows survive or not:
 *
 * - `INSERT … ON CONFLICT (idx, tenant_id, id) DO UPDATE` upserts on the
 *   primary key.
 * - `DELETE … WHERE idx = $1 [AND tenant_id = $2 [AND id = $3]]` deletes the
 *   rows matching every given column.
 * - `SELECT` / `count(*)` without a text query filter on `idx` and
 *   `tenant_id`, honouring `LIMIT` / `OFFSET`.
 *
 * Anything else throws, so an unexpected statement cannot pass silently.
 */
class TablePg implements PgClientLike {
  readonly rows = new Map<string, { idx: string; tenant_id: string; id: string; document: Record<string, unknown> }>()

  async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    if (/^CREATE /.test(text)) return { rows: [] }
    if (/^INSERT INTO/.test(text)) {
      const [idx, tenant_id, id, document] = params as [string, string, string, string]
      this.rows.set(`${idx}\u0000${tenant_id}\u0000${id}`, { idx, tenant_id, id, document: JSON.parse(document) })
      return { rows: [] }
    }
    const where = /WHERE (idx = \$1(?: AND tenant_id = \$2)?(?: AND id = \$3)?)(?: ORDER| LIMIT|$)/.exec(text)
    if (!where) throw new Error(`TablePg: unsupported statement ${text}`)
    const columns = where[1]!.split(' AND ').map((clause) => clause.split(' = ')[0] as 'idx' | 'tenant_id' | 'id')
    const matching = [...this.rows.entries()].filter(([, row]) => columns.every((column, i) => row[column] === params[i]))

    if (/^DELETE FROM/.test(text)) {
      for (const [key] of matching) this.rows.delete(key)
      return { rows: [] }
    }
    if (/count\(\*\)/.test(text)) return { rows: [{ total: matching.length }] }
    if (/^SELECT/.test(text)) {
      const [limit, offset] = params.slice(columns.length) as [number, number]
      return {
        rows: matching.slice(offset, offset + limit).map(([, row]) => ({ id: row.id, document: row.document, score: 0 })),
      }
    }
    throw new Error(`TablePg: unsupported statement ${text}`)
  }
}

describe('PostgresSearchDriver.clearTenant', () => {
  it('deletes one tenant of one index, by column, and nothing else', async () => {
    const pg = new TablePg()
    const driver = new PostgresSearchDriver({ client: pg })
    await driver.bulk('docs', [
      { id: '1', tenantId: 'acme', title: 'a' },
      { id: '1', tenantId: 'globex', title: 'g' },
    ])
    await driver.bulk('other', [{ id: '1', tenantId: 'acme', title: 'a' }])

    await driver.clearTenant('docs', 'acme')
    expect([...pg.rows.values()].map((row) => `${row.idx}/${row.tenant_id}`).sort()).toEqual(['docs/globex', 'other/acme'])
  })

  it('a per-tenant reindex (database-per-tenant backfill) keeps every other tenant', async () => {
    const pg = new TablePg()
    const driver = new PostgresSearchDriver({ client: pg })
    await driver.register({ name: 'docs', fields: ['title'] })
    const databases: Record<string, Array<{ id: string; title: string }>> = {
      acme: [
        { id: '1', title: 'acme one' },
        { id: '2', title: 'acme two' },
      ],
      globex: [{ id: '1', title: 'globex one' }],
    }
    let active = ''
    const search = new Search(
      {
        driver,
        rules: [
          {
            index: 'docs',
            document: (row: never) => row,
            async *backfill() {
              yield databases[active]!.map((row) => ({ ...row, tenantId: active })) as never[]
            },
          },
        ] as never,
      },
      () => true,
    )

    for (const tenant of ['acme', 'globex']) {
      active = tenant
      await search.reindex('docs', { tenantId: tenant })
    }

    // Old code: `clear()` ran for globex's rebuild and took acme's rows too.
    expect((await driver.search('docs', { tenantId: 'acme', q: '' })).total).toBe(2)
    expect((await driver.search('docs', { tenantId: 'globex', q: '' })).total).toBe(1)
  })
})
