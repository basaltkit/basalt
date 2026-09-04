import { describe, expect, it } from 'vitest'
import { PostgresSearchDriver } from '../src/index.js'

/**
 * F-12 · The language argument must be cast to `regconfig`.
 *
 * `PgClientLike` is deliberately open — anything with `query()` qualifies — and
 * that is the point of the bug. The `pg` client sends parameters untyped and
 * lets Postgres infer `$5` as `regconfig`, so `to_tsvector($5, $6)` works.
 * Prisma sends them typed as `text`, and `to_tsvector(text, text)` does not
 * exist: **error 42883, undefined function**.
 *
 * Prisma is the client `@basaltkit/prisma` recommends, so two official pieces
 * of the same toolkit did not fit together. The application that found this
 * shipped a shim that rewrote the driver's SQL with a regular expression before
 * executing it — a shim it then had to keep in sync with this package.
 *
 * The cast is redundant under `pg` and required under Prisma, which is why it
 * belongs in the driver rather than in every app.
 */
const recorder = () => {
  const sql: string[] = []
  const client = {
    async query(text: string) {
      sql.push(text)
      return { rows: [], rowCount: 0 }
    },
  }
  return { sql, client }
}

const index = { name: 'posts', fields: ['title'] }
const driver = (client: unknown) =>
  new PostgresSearchDriver({ client: client as never, table: 'basalt_search' })

describe('F-12 · language parameter is cast to regconfig', () => {
  it('casts in to_tsvector when indexing', async () => {
    const { sql, client } = recorder()
    const d = driver(client)
    await d.register(index as never)
    await d.index('posts', { id: '1', tenantId: 't', title: 'hello' } as never)

    const insert = sql.find((s) => s.startsWith('INSERT INTO')) as string
    expect(insert).toContain('to_tsvector($5::regconfig, $6)')
  })

  it('casts in plainto_tsquery when searching', async () => {
    const { sql, client } = recorder()
    const d = driver(client)
    await d.register(index as never)
    await d.search('posts', { tenantId: 't', q: 'hello' } as never)

    const select = sql.find((s) => s.includes('plainto_tsquery')) as string
    expect(select).toBeDefined()
    // Both occurrences — the driver builds the tsquery once and uses it for
    // ranking and for matching; a cast on only one of them still fails.
    expect(select.match(/plainto_tsquery\(\$\d+::regconfig, \$\d+\)/g)?.length).toBe(2)
  })

  it('leaves the query shape otherwise untouched', async () => {
    // The cast must not change parameter numbering or the surrounding SQL:
    // anything already deployed against this driver has to keep working.
    const { sql, client } = recorder()
    const d = driver(client)
    await d.register(index as never)
    await d.index('posts', { id: '1', tenantId: 't', title: 'hello' } as never)

    const insert = sql.find((s) => s.startsWith('INSERT INTO')) as string
    expect(insert).toContain('VALUES ($1, $2, $3, $4::jsonb, to_tsvector($5::regconfig, $6))')
  })
})
