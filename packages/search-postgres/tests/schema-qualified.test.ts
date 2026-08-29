import { describe, expect, it } from 'vitest'
import { PostgresSearchDriver } from '../src/index.js'

/** Records every SQL string the driver issues. */
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

describe('F-11 · register() with a schema-qualified table', () => {
  it('does not emit a schema-qualified INDEX name (a Postgres syntax error)', async () => {
    const { sql, client } = recorder()
    await new PostgresSearchDriver({ client: client as never, table: 'app.search' }).register(index as never)

    const createIndex = sql.find((s) => s.startsWith('CREATE INDEX')) as string
    // "CREATE INDEX … app.search_tsv_idx" is invalid: index names cannot be qualified.
    expect(/CREATE INDEX IF NOT EXISTS\s+[A-Za-z_][A-Za-z0-9_]*\s+ON/.test(createIndex)).toBe(true)
  })

  it('still places the index ON the qualified table', async () => {
    const { sql, client } = recorder()
    await new PostgresSearchDriver({ client: client as never, table: 'app.search' }).register(index as never)

    expect(sql.find((s) => s.startsWith('CREATE INDEX'))).toContain('ON app.search ')
  })

  it('keeps the plain (unqualified) name unchanged', async () => {
    const { sql, client } = recorder()
    await new PostgresSearchDriver({ client: client as never, table: 'basalt_search' }).register(index as never)

    expect(sql.find((s) => s.startsWith('CREATE INDEX'))).toContain('basalt_search_tsv_idx ON basalt_search ')
  })
})
