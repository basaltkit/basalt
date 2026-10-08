import { describe, expect, it } from 'vitest'
import {
  DelimitedParseError,
  createCsvFormatter,
  defineImport,
  parseDelimited,
  readImport,
  type DelimitedInput,
  type DelimitedRecord,
  type ParseDelimitedOptions,
} from '../src/index.js'

async function parse(input: DelimitedInput, options?: ParseDelimitedOptions): Promise<DelimitedRecord[]> {
  const out: DelimitedRecord[] = []
  for await (const record of parseDelimited(input, options)) out.push(record)
  return out
}

async function parseError(input: DelimitedInput, options?: ParseDelimitedOptions): Promise<DelimitedParseError> {
  try {
    await parse(input, options)
  } catch (error) {
    if (error instanceof DelimitedParseError) return error
    throw error
  }
  throw new Error('expected a DelimitedParseError')
}

async function* chunked(text: string, size: number, bytes = false): AsyncGenerator<string | Uint8Array> {
  const data = bytes ? new TextEncoder().encode(text) : text
  for (let i = 0; i < data.length; i += size) yield data.slice(i, i + size)
}

describe('parseDelimited (RFC 4180)', () => {
  it('reads plain records with CRLF, LF and lone CR line breaks', async () => {
    expect(await parse('a,b\r\nc,d\ne,f\rg,h')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['c', 'd'] },
      { line: 3, cells: ['e', 'f'] },
      { line: 4, cells: ['g', 'h'] },
    ])
  })

  it('handles quoted delimiters, doubled quotes and empty fields', async () => {
    expect(await parse('"a,b","say ""hi""",,""\r\n')).toEqual([{ line: 1, cells: ['a,b', 'say "hi"', '', ''] }])
  })

  it('keeps line breaks inside quoted fields and counts physical lines across them', async () => {
    const records = await parse('h1;h2\r\n"line one\r\nline two\nline three";x\r\nnext;y\r\n', { delimiter: ';' })
    expect(records).toEqual([
      { line: 1, cells: ['h1', 'h2'] },
      { line: 2, cells: ['line one\r\nline two\nline three', 'x'] },
      { line: 5, cells: ['next', 'y'] },
    ])
  })

  it('skips blank lines but keeps a quoted empty record', async () => {
    expect(await parse('a\n\n\r\nb\n""\n')).toEqual([
      { line: 1, cells: ['a'] },
      { line: 4, cells: ['b'] },
      { line: 5, cells: [''] },
    ])
  })

  it('keeps a trailing empty field', async () => {
    expect(await parse('a,\n')).toEqual([{ line: 1, cells: ['a', ''] }])
  })

  it('strips an optional BOM, or rejects it with bom: forbid', async () => {
    expect(await parse('﻿Número\n1')).toEqual([
      { line: 1, cells: ['Número'] },
      { line: 2, cells: ['1'] },
    ])
    const bytes = createCsvFormatter({ bom: true }).render(['Número'], [['1']])
    expect((await parse(bytes))[0]).toEqual({ line: 1, cells: ['Número'] })
    expect((await parseError('﻿a', { bom: 'forbid' })).reason).toBe('BOM_FORBIDDEN')
  })

  it('reads the same records from byte and string chunks split anywhere (multi-byte characters too)', async () => {
    const text = '﻿Nome;Valor\r\n"Ação, ""Lda""";1.250,50\r\n"multi\r\nline";ç\r\n'
    const whole = await parse(text, { delimiter: ';' })
    for (const size of [1, 2, 3, 7]) {
      expect(await parse(chunked(text, size), { delimiter: ';' })).toEqual(whole)
      expect(await parse(chunked(text, size, true), { delimiter: ';' })).toEqual(whole)
    }
    expect(whole[1]).toEqual({ line: 2, cells: ['Ação, "Lda"', '1.250,50'] })
  })

  it('rejects an unterminated quote at the line where the field started', async () => {
    const error = await parseError('a,b\n1,"never closed\n2,3\n4,5')
    expect(error.reason).toBe('UNTERMINATED_QUOTE')
    expect(error.code).toBe('CSV_UNTERMINATED_QUOTE')
    expect(error.line).toBe(2)
  })

  it('rejects text after a closing quote and a quote inside an unquoted field', async () => {
    expect(await parseError('a\n"x"y')).toMatchObject({ reason: 'INVALID_QUOTE', line: 2 })
    expect(await parseError('a\nb\n12" pipe')).toMatchObject({ reason: 'INVALID_QUOTE', line: 3 })
  })

  it('enforces maxRows while streaming, before yielding the extra record', async () => {
    let yielded = 0
    async function* rows(): AsyncGenerator<string> {
      for (let i = 0; i < 1_000_000; i++) {
        yielded = i
        yield `${i}\n`
      }
    }
    const seen: number[] = []
    let caught: unknown
    try {
      for await (const record of parseDelimited(rows(), { maxRows: 2001 })) seen.push(record.line)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DelimitedParseError)
    expect(caught).toMatchObject({ reason: 'TOO_MANY_ROWS', line: 2002 })
    expect(seen).toHaveLength(2001)
    expect(yielded).toBeLessThan(2010) // stopped early, did not read the whole input
  })

  it('enforces maxFieldLength', async () => {
    expect(await parseError(`a\n${'x'.repeat(11)}`, { maxFieldLength: 10 })).toMatchObject({ reason: 'FIELD_TOO_LARGE', line: 2 })
    expect(await parseError(`a\n"${'x'.repeat(11)}"`, { maxFieldLength: 10 })).toMatchObject({ reason: 'FIELD_TOO_LARGE' })
  })

  it('rejects invalid UTF-8 bytes', async () => {
    expect((await parseError(new Uint8Array([0x61, 0xff, 0x62]))).reason).toBe('INVALID_ENCODING')
  })

  it('reports invalid UTF-8 in a later chunk at the line reached so far', async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('a\nb\nc\n')
      yield new Uint8Array([0xff])
    }
    expect(await parseError(chunks())).toMatchObject({ reason: 'INVALID_ENCODING', line: 4 })
  })

  it('validates the delimiter and quote', async () => {
    await expect(parse('a', { delimiter: ';;' })).rejects.toThrow(TypeError)
    await expect(parse('a', { delimiter: '"' })).rejects.toThrow(TypeError)
  })
})

describe('defineImport / readImport', () => {
  interface PurchaseOrderLine {
    number: string
    supplier: string | null
    quantity: number
    unitPrice: number
    dueDate: Date | null
  }

  const purchaseOrders = defineImport<PurchaseOrderLine>({
    name: 'purchase-orders',
    delimiter: ';',
    locale: { decimal: ',', thousands: ' ', date: 'dd/mm/yyyy' },
    columns: [
      { key: 'number', headers: ['Número', 'Nº'], required: true },
      { key: 'supplier', headers: ['Fornecedor'] },
      { key: 'quantity', headers: ['Quantidade', 'Qtd'], required: true, parse: 'integer' },
      { key: 'unitPrice', headers: ['Preço unitário'], required: true, parse: 'decimal' },
      { key: 'dueDate', headers: ['Data de entrega'], parse: 'date' },
    ],
  })

  it('maps headers by folded name, in any order, and parses pt numbers and dates', async () => {
    const csv = [
      '﻿PREÇO  UNITÁRIO;numero;Qtd;Data de Entrega;Notas',
      '1.250,50;PO-1;1 000;14/03/2026;x',
      '1 408 278,55;PO-2;3;;y',
      '-12,5;PO-3;2;29/02/2028;z',
    ].join('\r\n')
    const result = await readImport(purchaseOrders, csv)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([{ line: 1, column: 'Notas', code: 'UNKNOWN_COLUMN', message: 'Unknown column "Notas".' }])
    expect(result.rows).toEqual([
      { line: 2, value: { number: 'PO-1', supplier: null, quantity: 1000, unitPrice: 1250.5, dueDate: new Date('2026-03-14T00:00:00Z') } },
      { line: 3, value: { number: 'PO-2', supplier: null, quantity: 3, unitPrice: 1408278.55, dueDate: null } },
      { line: 4, value: { number: 'PO-3', supplier: null, quantity: 2, unitPrice: -12.5, dueDate: new Date('2028-02-29T00:00:00Z') } },
    ])
  })

  it("never guesses a decimal: '12.5' is AMBIGUOUS with a comma decimal, '1.250' is 1250", async () => {
    const csv = 'Número;Qtd;Preço unitário\nA;1;12.5\nB;1;1.250\nC;1;1.25\nD;1;12,5\nE;1;abc\nF;1;1.2500'
    const result = await readImport(purchaseOrders, csv)
    expect(result.rows.map((r) => [r.value.number, r.value.unitPrice])).toEqual([
      ['B', 1250],
      ['D', 12.5],
    ])
    expect(result.errors.map((e) => [e.line, e.column, e.code])).toEqual([
      [2, 'unitPrice', 'AMBIGUOUS_DECIMAL'],
      [4, 'unitPrice', 'AMBIGUOUS_DECIMAL'],
      [6, 'unitPrice', 'INVALID_DECIMAL'],
      [7, 'unitPrice', 'AMBIGUOUS_DECIMAL'],
    ])
  })

  it('never reads a thousands group that starts with 0 (0.250 is a mistyped 0,25)', async () => {
    const csv = 'Número;Qtd;Preço unitário\nA;1;0.250\nB;1;-0.250\nC;1;0,250\nD;1;10.250'
    const result = await readImport(purchaseOrders, csv)
    expect(result.rows.map((r) => [r.value.number, r.value.unitPrice])).toEqual([
      ['C', 0.25],
      ['D', 10250],
    ])
    expect(result.errors.map((e) => [e.line, e.code])).toEqual([
      [2, 'AMBIGUOUS_DECIMAL'],
      [3, 'AMBIGUOUS_DECIMAL'],
    ])
  })

  it("accepts a '-' thousands separator literally (escaped in the character class)", async () => {
    const def = defineImport<{ v: number }>({
      name: 'x',
      delimiter: ';',
      locale: { decimal: ',', thousands: '-' },
      columns: [{ key: 'v', headers: ['v'], parse: 'decimal' }],
    })
    const result = await readImport(def, 'v\n1-250,5\n1_250,5')
    expect(result.rows.map((r) => r.value.v)).toEqual([1250.5])
    expect(result.errors).toMatchObject([{ line: 3, code: 'INVALID_DECIMAL' }])
  })

  it('applies the same strictness to a dot decimal', async () => {
    const def = defineImport<{ v: number }>({ name: 'x', columns: [{ key: 'v', headers: ['v'], parse: 'decimal' }] })
    const result = await readImport(def, 'v\n"1,250.50"\n12.5\n"12,5"')
    expect(result.rows.map((r) => r.value.v)).toEqual([1250.5, 12.5])
    expect(result.errors).toMatchObject([{ line: 4, code: 'AMBIGUOUS_DECIMAL' }])
  })

  it('rejects impossible calendar dates and wrong shapes', async () => {
    const csv = 'Número;Qtd;Preço unitário;Data de entrega\nA;1;1;31/02/2026\nB;1;1;29/02/2026\nC;1;1;2026-03-14\nD;1;1;1/3/2026'
    const result = await readImport(purchaseOrders, csv)
    expect(result.errors.map((e) => [e.line, e.code])).toEqual([
      [2, 'INVALID_DATE'],
      [3, 'INVALID_DATE'],
      [4, 'INVALID_DATE'],
    ])
    expect(result.rows.map((r) => r.value.dueDate)).toEqual([new Date('2026-03-01T00:00:00Z')])
  })

  it('reads ISO dates by default', async () => {
    const def = defineImport<{ d: Date }>({ name: 'x', columns: [{ key: 'd', headers: ['d'], parse: 'date' }] })
    const result = await readImport(def, 'd\n2026-03-14\n2026-03-14T10:00:00+01:00\n2026-02-30\n14/03/2026')
    expect(result.rows.map((r) => r.value.d.toISOString())).toEqual(['2026-03-14T00:00:00.000Z', '2026-03-14T09:00:00.000Z'])
    expect(result.errors.map((e) => e.line)).toEqual([4, 5])
  })

  it('reports every bad cell of a row with its line and column key, and never throws', async () => {
    const csv = 'Número;Qtd;Preço unitário\n;x;\nOK;2;3\n"multi\nline";1;1\nZ;1'
    const result = await readImport(purchaseOrders, csv)
    expect(result.errors).toEqual([
      { line: 2, column: 'number', code: 'REQUIRED', message: '"Número" is required.' },
      { line: 2, column: 'quantity', code: 'INVALID_INTEGER', message: expect.any(String) },
      { line: 2, column: 'unitPrice', code: 'REQUIRED', message: '"Preço unitário" is required.' },
      { line: 6, code: 'COLUMN_COUNT', message: 'Expected 3 fields, found 2.' },
    ])
    expect(result.rows.map((r) => [r.line, r.value.number])).toEqual([
      [3, 'OK'],
      [4, 'multi\nline'],
    ])
  })

  it('fails the whole file on missing required or duplicate columns', async () => {
    const missing = await readImport(purchaseOrders, 'Número;Fornecedor\nA;B')
    expect(missing.rows).toEqual([])
    expect(missing.errors.map((e) => [e.code, e.column])).toEqual([
      ['MISSING_COLUMN', 'quantity'],
      ['MISSING_COLUMN', 'unitPrice'],
    ])
    const duplicate = await readImport(purchaseOrders, 'Número;Nº;Qtd;Preço unitário\nA;A;1;1')
    expect(duplicate.rows).toEqual([])
    expect(duplicate.errors).toMatchObject([{ line: 1, column: 'number', code: 'DUPLICATE_COLUMN' }])
  })

  it('can treat unknown columns as errors', async () => {
    const strict = defineImport<{ a: string }>({ name: 'x', unknownColumns: 'error', columns: [{ key: 'a', headers: ['a'] }] })
    const result = await readImport(strict, 'a,b\n1,2')
    expect(result.rows).toEqual([])
    expect(result.errors).toMatchObject([{ code: 'UNKNOWN_COLUMN', column: 'b' }])
  })

  it('fails closed on a malformed file: no partial rows', async () => {
    const result = await readImport(purchaseOrders, 'Número;Qtd;Preço unitário\nA;1;1\nB;1;"1\nC;1;1')
    expect(result.rows).toEqual([])
    expect(result.errors).toEqual([{ line: 3, code: 'UNTERMINATED_QUOTE', message: expect.stringContaining('Line 3') }])
  })

  it('caps the data rows (header excluded) while streaming', async () => {
    const capped = defineImport<{ a: string }>({ name: 'x', maxRows: 2000, columns: [{ key: 'a', headers: ['a'] }] })
    const ok = await readImport(capped, ['a', ...Array.from({ length: 2000 }, (_, i) => String(i))].join('\n'))
    expect(ok.rows).toHaveLength(2000)
    const over = await readImport(capped, ['a', ...Array.from({ length: 2001 }, (_, i) => String(i))].join('\n'))
    expect(over.rows).toEqual([])
    expect(over.errors).toEqual([{ line: 2002, code: 'TOO_MANY_ROWS', message: 'The file has more than 2000 rows.' }])
  })

  it('caps the number of reported errors', async () => {
    const def = defineImport<{ n: number }>({ name: 'x', maxErrors: 3, columns: [{ key: 'n', headers: ['n'], parse: 'integer' }] })
    const result = await readImport(def, ['n', 'a', 'b', 'c', 'd', 'e', '7'].join('\n'))
    expect(result.errors.map((e) => e.code)).toEqual(['INVALID_INTEGER', 'INVALID_INTEGER', 'INVALID_INTEGER', 'TOO_MANY_ERRORS'])
    expect(result.rows.map((r) => r.value.n)).toEqual([7])
  })

  it('reports an empty file', async () => {
    expect((await readImport(purchaseOrders, '')).errors).toMatchObject([{ code: 'EMPTY_FILE' }])
  })

  it('accepts a function parser; a throw becomes INVALID_VALUE', async () => {
    const def = defineImport<{ nif: string }>({
      name: 'x',
      columns: [
        {
          key: 'nif',
          headers: ['NIF'],
          parse: (v) => {
            if (!/^\d{9,14}$/.test(v)) throw new Error(`"${v}" is not a NIF.`)
            return v
          },
        },
      ],
    })
    const result = await readImport(def, 'NIF\n5417000000\nabc')
    expect(result.rows.map((r) => r.value.nif)).toEqual(['5417000000'])
    expect(result.errors).toEqual([{ line: 3, column: 'nif', code: 'INVALID_VALUE', message: '"abc" is not a NIF.' }])
  })

  it('validates the definition up front', () => {
    expect(() =>
      defineImport<{ a: string; b: string }>({
        name: 'x',
        columns: [
          { key: 'a', headers: ['Número'] },
          { key: 'b', headers: ['NUMERO'] },
        ],
      }),
    ).toThrow(/claimed by both/)
    expect(() =>
      defineImport<{ a: string }>({
        name: 'x',
        columns: [
          { key: 'a', headers: ['a'] },
          { key: 'a', headers: ['b'] },
        ],
      }),
    ).toThrow(/duplicate column key/)
    expect(() =>
      defineImport<{ d: Date }>({
        name: 'x',
        locale: { decimal: ',', date: (d) => d.toISOString() },
        columns: [{ key: 'd', headers: ['d'], parse: 'date' }],
      }),
    ).toThrow(/function parser/)
  })

  it('readImport applies the definition checks to a definition not built with defineImport', async () => {
    const raw = {
      name: 'x',
      columns: [
        { key: 'a' as const, headers: ['Número'] },
        { key: 'b' as const, headers: ['NUMERO'] },
      ],
    }
    await expect(readImport<{ a: string; b: string }>(raw, 'Numero\n1')).rejects.toThrow(/claimed by both/)
  })

  it('round-trips what createCsvFormatter writes', async () => {
    const formatter = createCsvFormatter({ delimiter: ';', bom: true, locale: { decimal: ',', thousands: ' ', date: 'dd/mm/yyyy' } })
    const file = formatter.render(
      ['Número', 'Qtd', 'Preço unitário', 'Data de entrega', 'Fornecedor'],
      [['PO-9', 1200, 1408278.55, new Date('2026-03-14T00:00:00Z'), 'Acme; "Lda"']],
    )
    const result = await readImport(purchaseOrders, file)
    expect(result.errors).toEqual([])
    expect(result.rows[0]!.value).toEqual({
      number: 'PO-9',
      supplier: 'Acme; "Lda"',
      quantity: 1200,
      unitPrice: 1408278.55,
      dueDate: new Date('2026-03-14T00:00:00Z'),
    })
  })
})
