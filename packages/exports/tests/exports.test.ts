import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import {
  EXPORTS,
  Exports,
  UnknownExportFormatError,
  csvFormatter,
  defineExport,
  exportsPlugin,
  type ExportFormatter,
} from '../src/index.js'

interface User {
  name: string
  email: string
  joined: Date
}

const usersExport = defineExport<User>({
  name: 'users',
  columns: [
    { header: 'Name', value: (u) => u.name },
    { header: 'Email', value: (u) => u.email },
    { header: 'Joined', value: (u) => u.joined },
  ],
})

const rows: User[] = [
  { name: 'Ada', email: 'ada@x.test', joined: new Date('2026-01-02T00:00:00Z') },
  { name: 'Bob, Jr.', email: 'bob@x.test', joined: new Date('2026-02-03T00:00:00Z') },
]

describe('formatters', () => {
  it('CSV quotes fields with delimiters, quotes and newlines; uses CRLF', () => {
    const out = csvFormatter
      .render(['A', 'B'], [['plain', 'has,comma'], ['he said "hi"', 'line1\nline2']])
      .toString()
    expect(out).toBe('A,B\r\nplain,"has,comma"\r\n"he said ""hi""","line1\nline2"')
  })

  it('neutralizes spreadsheet formula injection in string cells', () => {
    const out = csvFormatter
      .render(['A', 'B'], [['=WEBSERVICE("http://evil")', '+1+2'], ['@cmd', '-5']])
      .toString()
    // each risky string is prefixed with a quote so a spreadsheet treats it as text
    expect(out).toBe('A,B\r\n"\'=WEBSERVICE(""http://evil"")",\'+1+2\r\n\'@cmd,\'-5')
    // a genuine negative NUMBER is untouched (only strings are guarded)
    const nums = csvFormatter.render(['N'], [[-5]]).toString()
    expect(nums).toBe('N\r\n-5')
  })
})

describe('Exports.run', () => {
  it('renders a definition to CSV with headers, ISO dates and a filename', async () => {
    const exports = new Exports()
    const result = await exports.run(usersExport, rows, 'csv')
    expect(result).toMatchObject({ contentType: 'text/csv', filename: 'users.csv', format: 'csv', rowCount: 2 })
    expect(result.content.toString()).toBe(
      'Name,Email,Joined\r\nAda,ada@x.test,2026-01-02T00:00:00.000Z\r\n"Bob, Jr.",bob@x.test,2026-02-03T00:00:00.000Z',
    )
  })

  it('renders TSV, JSON and NDJSON', async () => {
    const exports = new Exports()
    expect((await exports.run(usersExport, rows, 'tsv')).content.toString().split('\r\n')[0]).toBe('Name\tEmail\tJoined')

    const json = JSON.parse((await exports.run(usersExport, rows, 'json')).content.toString())
    expect(json[0]).toMatchObject({ Name: 'Ada', Email: 'ada@x.test' })

    const ndjson = (await exports.run(usersExport, rows, 'ndjson')).content.toString().split('\n')
    expect(ndjson).toHaveLength(2)
    expect(JSON.parse(ndjson[1]!).Name).toBe('Bob, Jr.')
  })

  it('accepts an async iterable (streamed rows)', async () => {
    async function* stream(): AsyncGenerator<User> {
      for (const row of rows) yield row
    }
    const result = await new Exports().run(usersExport, stream(), 'json')
    expect(result.rowCount).toBe(2)
  })

  it('throws on an unknown format', async () => {
    await expect(new Exports().run(usersExport, rows, 'xlsx')).rejects.toBeInstanceOf(UnknownExportFormatError)
  })

  it('accepts a custom formatter', async () => {
    const upper: ExportFormatter = {
      format: 'upper',
      contentType: 'text/plain',
      extension: 'txt',
      render: (headers, r) => Buffer.from([headers, ...r.map((x) => x.map(String))].map((line) => line.join('|').toUpperCase()).join('\n')),
    }
    const result = await new Exports({ formatters: [upper] }).run(usersExport, rows.slice(0, 1), 'upper')
    expect(result.content.toString()).toContain('ADA|ADA@X.TEST')
  })
})

describe('exportsPlugin', () => {
  it('registers EXPORTS with the native formats', async () => {
    const app = await createApp({ plugins: [exportsPlugin()] }).boot()
    expect(app.container.get(EXPORTS).formats()).toEqual(expect.arrayContaining(['csv', 'tsv', 'json', 'ndjson']))
    await app.shutdown()
  })
})
