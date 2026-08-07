import { describe, expect, it } from 'vitest'
import { PostgresSearchDriver, type PgClientLike } from '../src/index.js'

interface Call {
  text: string
  params?: unknown[] | undefined
}

class FakePg implements PgClientLike {
  readonly calls: Call[] = []
  searchRows: Record<string, unknown>[] = []
  total = 0
  async query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ text, params })
    if (/count\(\*\)/.test(text)) return { rows: [{ total: this.total }] }
    if (/^SELECT/.test(text)) return { rows: this.searchRows }
    return { rows: [] }
  }
  find(re: RegExp): Call {
    return this.calls.find((c) => re.test(c.text))!
  }
}

const driverWith = (pg: FakePg) => new PostgresSearchDriver({ client: pg })

describe('PostgresSearchDriver', () => {
  it('register creates the table and a GIN index', async () => {
    const pg = new FakePg()
    await driverWith(pg).register({ name: 'notes', fields: ['title', 'body'], filterable: ['folder'] })
    expect(pg.find(/CREATE TABLE/).text).toContain('machize_search')
    expect(pg.find(/CREATE INDEX/).text).toContain('USING gin(tsv)')
  })

  it('indexes a document with an upsert and a tsvector', async () => {
    const pg = new FakePg()
    const driver = driverWith(pg)
    await driver.register({ name: 'notes', fields: ['title'], filterable: [] })
    await driver.index('notes', { id: '1', tenantId: 'acme', title: 'Hello world', body: 'ignored' })

    const insert = pg.find(/INSERT INTO/)
    expect(insert.text).toContain('ON CONFLICT (idx, tenant_id, id) DO UPDATE')
    expect(insert.text).toContain('to_tsvector($5, $6)')
    // only the configured field (title) feeds the tsvector
    expect(insert.params).toEqual(['notes', 'acme', '1', JSON.stringify({ id: '1', tenantId: 'acme', title: 'Hello world', body: 'ignored' }), 'english', 'Hello world'])
  })

  it('searches with a tenant-scoped, ranked full-text query and filters', async () => {
    const pg = new FakePg()
    pg.searchRows = [{ id: '1', document: { id: '1', tenantId: 'acme', title: 'Hello' }, score: 0.42 }]
    pg.total = 1
    const res = await driverWith(pg).search('notes', { tenantId: 'acme', q: 'hello', filters: { folder: 'inbox', tag: ['a', 'b'] }, limit: 10, offset: 0 })

    const select = pg.find(/ts_rank/)
    expect(select.text).toContain('ts_rank(tsv, plainto_tsquery($3, $4))')
    expect(select.text).toContain('idx = $1 AND tenant_id = $2')
    expect(select.text).toContain('document->>$5 = $6') // scalar filter
    expect(select.text).toContain('document->>$7 = ANY($8)') // array filter
    expect(select.params).toEqual(['notes', 'acme', 'english', 'hello', 'folder', 'inbox', 'tag', ['a', 'b'], 10, 0])

    expect(res.hits[0]).toMatchObject({ id: '1', score: 0.42 })
    expect(res.total).toBe(1)
  })

  it('an empty query lists (score 0, no tsquery) and stays tenant-scoped', async () => {
    const pg = new FakePg()
    await driverWith(pg).search('notes', { tenantId: 'acme', q: '' })
    const select = pg.find(/^SELECT id/)
    expect(select.text).toContain('0 AS score')
    expect(select.text).not.toContain('plainto_tsquery')
    expect(select.text).toContain('tenant_id = $2')
  })

  it('removes and clears', async () => {
    const pg = new FakePg()
    const driver = driverWith(pg)
    await driver.remove('notes', 'acme', '1')
    await driver.clear('notes')
    expect(pg.find(/DELETE FROM.*id = \$3/).params).toEqual(['notes', 'acme', '1'])
    expect(pg.find(/DELETE FROM machize_search WHERE idx = \$1$/).params).toEqual(['notes'])
  })
})
