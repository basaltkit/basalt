import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  ExportNotStreamableError,
  Exports,
  UnknownExportFormatError,
  defineExport,
  type ExportFormatter,
} from '../src/index.js'

interface Row {
  id: number
  note: string
  at: Date
}

const rowsExport = defineExport<Row>({
  name: 'rows',
  columns: [
    { header: 'Id', value: (r) => r.id },
    { header: 'Note', value: (r) => r.note },
    { header: 'At', value: (r) => r.at },
  ],
})

const sample: Row[] = [
  { id: 1, note: 'plain', at: new Date('2026-01-02T00:00:00Z') },
  { id: 2, note: 'has, comma and "quotes"\nand a newline', at: new Date('2026-02-03T00:00:00Z') },
  { id: 3, note: '=HYPERLINK("http://evil")', at: new Date('2026-03-04T00:00:00Z') },
]

async function drain(iterable: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function* generate(n: number, onPull?: (i: number) => void): AsyncGenerator<Row> {
  for (let i = 0; i < n; i++) {
    onPull?.(i)
    yield { id: i, note: `row number ${i}`, at: new Date(Date.UTC(2026, 0, 1) + i * 1000) }
  }
}

describe('Exports.stream', () => {
  for (const format of ['csv', 'tsv', 'json', 'ndjson']) {
    it(`produces exactly the bytes of run() for ${format}`, async () => {
      const exports = new Exports()
      const buffered = await exports.run(rowsExport, sample, format)
      const stream = exports.stream(rowsExport, sample, format)
      expect(await drain(stream)).toEqual(buffered.content)
      expect(stream).toMatchObject({
        contentType: buffered.contentType,
        filename: buffered.filename,
        format,
        rowCount: 3,
      })
    })

    it(`matches run() on an empty dataset for ${format}`, async () => {
      const exports = new Exports()
      const buffered = await exports.run(rowsExport, [], format)
      expect(await drain(exports.stream(rowsExport, [], format))).toEqual(buffered.content)
    })
  }

  it('consumes an AsyncIterable of 100k rows incrementally (bounded memory)', async () => {
    const total = 100_000
    let pulled = 0
    const stream = new Exports().stream(rowsExport, generate(total, () => pulled++), 'csv')

    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    expect(first.done).toBe(false)
    // The first chunk is emitted after reading only a small window of rows —
    // run() would have pulled all 100k before producing anything.
    expect(pulled).toBeGreaterThan(0)
    expect(pulled).toBeLessThan(total / 10)

    let bytes = (first.value as Buffer).length
    let lines = (first.value as Buffer).toString().split('\r\n').length - 1
    let maxChunk = bytes
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      bytes += next.value.length
      lines += next.value.toString().split('\r\n').length - 1
      maxChunk = Math.max(maxChunk, next.value.length)
    }
    expect(pulled).toBe(total)
    expect(lines).toBe(total) // header + total rows, joined by total separators
    expect(stream.rowCount).toBe(total)
    // Every chunk stays near the flush threshold, never the whole file.
    expect(maxChunk).toBeLessThan(128 * 1024)
    expect(bytes).toBeGreaterThan(maxChunk * 10)
  })

  it('pipes into a Node Readable', async () => {
    const stream = new Exports().stream(rowsExport, generate(3), 'ndjson')
    const text = (await drain(Readable.from(stream))).toString()
    expect(text.split('\n')).toHaveLength(3)
    expect(JSON.parse(text.split('\n')[2]!)).toMatchObject({ Id: 2, Note: 'row number 2' })
  })

  it('throws on an unknown format', () => {
    expect(() => new Exports().stream(rowsExport, sample, 'nope')).toThrow(UnknownExportFormatError)
  })

  it('refuses a formatter that cannot stream (buffer-only, e.g. xlsx/pdf)', () => {
    const bufferOnly: ExportFormatter = {
      format: 'xlsx',
      contentType: 'application/octet-stream',
      extension: 'xlsx',
      render: () => Buffer.from('x'),
    }
    const exports = new Exports({ formatters: [bufferOnly] })
    expect(() => exports.stream(rowsExport, sample, 'xlsx')).toThrow(ExportNotStreamableError)
    expect(exports.streamableFormats()).toEqual(['csv', 'tsv', 'json', 'ndjson'])
  })

  it('uses a custom formatter that implements renderStream', async () => {
    const lines: ExportFormatter = {
      format: 'lines',
      contentType: 'text/plain',
      extension: 'txt',
      render: (headers, rows) => Buffer.from([headers, ...rows].map((r) => r.join('|')).join('\n')),
      async *renderStream(headers, rows) {
        yield headers.join('|')
        for await (const row of rows) yield `\n${row.join('|')}`
      },
    }
    const out = await drain(new Exports({ formatters: [lines] }).stream(rowsExport, generate(2), 'lines'))
    expect(out.toString().split('\n')).toEqual([
      'Id|Note|At',
      `0|row number 0|${new Date(Date.UTC(2026, 0, 1)).toString()}`,
      `1|row number 1|${new Date(Date.UTC(2026, 0, 1) + 1000).toString()}`,
    ])
  })
})

describe('ExportStream', () => {
  it('can only be iterated once', async () => {
    const stream = new Exports().stream(rowsExport, sample, 'csv')
    await drain(stream)
    expect(() => stream[Symbol.asyncIterator]()).toThrow(/only be iterated once/)
  })
})
