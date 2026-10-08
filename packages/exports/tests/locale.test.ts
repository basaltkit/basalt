import { describe, expect, it } from 'vitest'
import {
  DelimitedFormatter,
  Exports,
  createCsvFormatter,
  csvFormatter,
  defineExport,
  type ExportColumnMeta,
  type ExportFormatter,
  type LocaleSpec,
} from '../src/index.js'

const pt: LocaleSpec = { decimal: ',', thousands: ' ', date: 'dd/mm/yyyy' }

async function drain(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const chunk of stream) parts.push(chunk)
  return Buffer.concat(parts)
}

describe('DelimitedFormatter bom/locale', () => {
  it('writes a UTF-8 BOM (EF BB BF) first when bom is on', () => {
    const buf = createCsvFormatter({ bom: true }).render(['Número'], [['1']])
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(buf.subarray(3).toString()).toBe('Número\r\n1')
  })

  it('keeps the native csv formatter BOM-less and unlocalized', () => {
    const buf = csvFormatter.render(['N', 'D'], [[1408278.55, new Date('2026-03-14T00:00:00Z')]])
    expect(buf[0]).toBe('N'.charCodeAt(0))
    expect(buf.toString()).toBe('N,D\r\n1408278.55,2026-03-14T00:00:00.000Z')
  })

  it('renders numbers and dates with a pt LocaleSpec', () => {
    const csv = createCsvFormatter({ delimiter: ';', locale: pt })
      .render(['Total', 'Data'], [[1408278.55, new Date('2026-03-14T00:00:00Z')]])
      .toString()
    expect(csv).toBe('Total;Data\r\n1 408 278,55;14/03/2026')
  })

  it('does not guard-quote a localized negative number', () => {
    const csv = createCsvFormatter({ delimiter: ';', locale: pt }).render(['V'], [[-1408278.55], [-5n], [0.5]]).toString()
    expect(csv).toBe('V\r\n-1 408 278,55\r\n-5\r\n0,5')
  })

  it('still guards a formula string (the guard is unchanged by a locale)', () => {
    const csv = createCsvFormatter({ delimiter: ';', locale: pt }).render(['V'], [['-1408278,55'], ['=SUM(1)']]).toString()
    expect(csv).toBe("V\r\n'-1408278,55\r\n'=SUM(1)")
  })

  it('still guards a Date-branded value after locale rendering', () => {
    const spoofed = Object.setPrototypeOf({ toISOString: () => '=HYPERLINK("x")' }, Date.prototype)
    const csv = createCsvFormatter({ locale: pt }).render(['D'], [[spoofed]]).toString()
    expect(csv).toBe('D\r\n"\'=HYPERLINK(""x"")"')
    const fn = createCsvFormatter({ locale: { decimal: '.', date: () => '+1' } }).render(['D'], [[new Date(0)]])
    expect(fn.toString()).toBe("D\r\n'+1")
  })

  it('quotes a comma decimal when the delimiter is also a comma', () => {
    expect(createCsvFormatter({ locale: { decimal: ',' } }).render(['V'], [[1.5]]).toString()).toBe('V\r\n"1,5"')
  })

  it('leaves NaN/Infinity/exponent numbers recognisable', () => {
    const csv = createCsvFormatter({ delimiter: ';', locale: pt }).render(['V'], [[Number.NaN], [1.5e21], [1e-7]])
    expect(csv.toString()).toBe('V\r\nNaN\r\n1,5e+21\r\n1e-7')
  })

  it('rejects a locale whose separators collide or contain digits', () => {
    expect(() => createCsvFormatter({ locale: { decimal: ',', thousands: ',' } })).toThrow(TypeError)
    expect(() => createCsvFormatter({ locale: { decimal: '.', thousands: '0' } })).toThrow(TypeError)
    expect(() => createCsvFormatter({ locale: { decimal: ',', thousands: '' } })).toThrow(TypeError)
    expect(() => createCsvFormatter({ locale: { decimal: ';' as ',' } })).toThrow(TypeError)
    expect(() => createCsvFormatter({ locale: { decimal: ',', thousands: '.' } })).not.toThrow()
  })

  it('rejects an invalid delimiter', () => {
    expect(() => createCsvFormatter({ delimiter: '"' })).toThrow(TypeError)
    expect(() => createCsvFormatter({ delimiter: ';;' })).toThrow(TypeError)
  })

  it('quotes fields containing a regex-special delimiter', () => {
    const f = new DelimitedFormatter('psv', ']', 'text/plain', 'txt')
    expect(f.render(['a]b'], [['c']]).toString()).toBe('"a]b"\r\nc')
  })

  it('stream() emits exactly the bytes of run(), BOM included', async () => {
    const def = defineExport<{ n: number; d: Date }>({
      name: 'invoices',
      columns: [
        { header: 'Número', value: (r) => r.n, type: 'number' },
        { header: 'Data', value: (r) => r.d, type: 'date' },
      ],
    })
    const rows = [
      { n: 1408278.55, d: new Date('2026-03-14T00:00:00Z') },
      { n: -12, d: new Date('2026-01-02T00:00:00Z') },
    ]
    const exports = new Exports({ formatters: [createCsvFormatter({ delimiter: ';', bom: true, locale: pt })] })
    const run = await exports.run(def, rows, 'csv')
    const streamed = await drain(exports.stream(def, rows, 'csv', { chunkSize: 1 }))
    expect(streamed.equals(run.content)).toBe(true)
    expect(run.content.toString()).toBe('﻿Número;Data\r\n1 408 278,55;14/03/2026\r\n-12;02/01/2026')
  })
})

describe('column metadata', () => {
  it('passes type/format/width hints to the formatter (render and renderStream)', async () => {
    const seen: (ExportColumnMeta[] | undefined)[] = []
    const probe: ExportFormatter = {
      format: 'probe',
      contentType: 'text/plain',
      extension: 'txt',
      render(_h, _r, columns) {
        seen.push(columns)
        return Buffer.from('')
      },
      async *renderStream(_h, rows, columns) {
        seen.push(columns)
        for await (const _ of rows) yield ''
      },
    }
    const def = defineExport<{ n: number }>({
      name: 'x',
      columns: [
        { header: 'N', value: (r) => r.n, type: 'number', format: '#,##0.00', width: 14 },
        { header: 'Plain', value: () => 'p' },
      ],
    })
    const exports = new Exports({ formatters: [probe] })
    await exports.run(def, [{ n: 1 }], 'probe')
    await drain(exports.stream(def, [{ n: 1 }], 'probe'))
    const expected = [{ header: 'N', type: 'number', format: '#,##0.00', width: 14 }, { header: 'Plain' }]
    expect(seen).toEqual([expected, expected])
  })
})
