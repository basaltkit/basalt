import { describe, expect, it } from 'vitest'
import { Exports, defineExport } from '@basaltkit/exports'
import { createXlsxFormatter, xlsxFormatter } from '../src/index.js'

/** Minimal STORE-method ZIP reader — enough to extract our parts by name. */
function unzipStore(buf: Buffer): Record<string, string> {
  let p = buf.length - 22
  while (p >= 0 && buf.readUInt32LE(p) !== 0x06054b50) p--
  const count = buf.readUInt16LE(p + 10)
  let cd = buf.readUInt32LE(p + 16)
  const out: Record<string, string> = {}
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(cd + 28)
    const extraLen = buf.readUInt16LE(cd + 30)
    const commentLen = buf.readUInt16LE(cd + 32)
    const localOff = buf.readUInt32LE(cd + 42)
    const name = buf.toString('utf8', cd + 46, cd + 46 + nameLen)
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const size = buf.readUInt32LE(localOff + 22)
    const start = localOff + 30 + lNameLen + lExtraLen
    out[name] = buf.toString('utf8', start, start + size)
    cd += 46 + nameLen + extraLen + commentLen
  }
  return out
}

describe('xlsxFormatter', () => {
  it('produces a valid ZIP with the expected OOXML parts', async () => {
    const buf = (await xlsxFormatter.render(['Name', 'Price'], [['Ada & Co', 29]])) as Buffer
    // ZIP local-file signature
    expect([...buf.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04])

    const parts = unzipStore(buf)
    expect(Object.keys(parts).sort()).toEqual(
      ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].sort(),
    )
  })

  it('writes headers, inline strings (escaped) and numeric cells', async () => {
    const buf = (await xlsxFormatter.render(['Name', 'Price'], [['Ada & Co', 29], ['<b>', 0]])) as Buffer
    const sheet = unzipStore(buf)['xl/worksheets/sheet1.xml']!
    expect(sheet).toContain('<t xml:space="preserve">Name</t>') // header
    expect(sheet).toContain('Ada &amp; Co') // escaped string
    expect(sheet).toContain('&lt;b&gt;')
    expect(sheet).toContain('<v>29</v>') // numeric cell
    expect(sheet).toContain('r="A1"') // cell references present
  })

  it('plugs into Exports as the "xlsx" format', async () => {
    const usersExport = defineExport<{ name: string }>({ name: 'users', columns: [{ header: 'Name', value: (u) => u.name }] })
    const result = await new Exports({ formatters: [xlsxFormatter] }).run(usersExport, [{ name: 'Ada' }], 'xlsx')
    expect(result.filename).toBe('users.xlsx')
    expect(result.contentType).toContain('spreadsheetml.sheet')
    expect(result.content.subarray(0, 2).toString()).toBe('PK')
    expect(unzipStore(result.content)['xl/worksheets/sheet1.xml']).toContain('Ada')
  })
})

describe('XLSX cells carrying XML control characters', () => {
  const sheetOf = async (value: string): Promise<string> => {
    const buf = (await xlsxFormatter.render(['Note'], [[value]])) as Buffer
    return unzipStore(buf)['xl/worksheets/sheet1.xml'] as string
  }

  it('never emits a raw control char (which makes the sheet invalid XML)', async () => {
    const sheet = await sheetOf(`bad${String.fromCharCode(0)}value${String.fromCharCode(8)}here`)
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(sheet)).toBe(false)
  })

  it('escapes them the OOXML way (_xHHHH_) instead of dropping the value', async () => {
    const sheet = await sheetOf(`a${String.fromCharCode(0)}b`)
    expect(sheet).toContain('a_x0000_b')
  })

  it('escapes a literal _xHHHH_ so the encoding round-trips unambiguously', async () => {
    expect(await sheetOf('_x0041_')).toContain('_x005F_x0041_')
  })

  it('leaves tab / newline / carriage return (legal XML) alone', async () => {
    const sheet = await sheetOf('a\tb\nc')
    expect(sheet).toContain('a\tb\nc')
  })
})

describe('createXlsxFormatter', () => {
  type Formatter = ReturnType<typeof createXlsxFormatter>
  const parts = async (formatter: Formatter, ...args: Parameters<Formatter['render']>) =>
    unzipStore((await formatter.render(...args)) as Buffer)

  it('adds a styles part, wired into the content types and workbook rels', async () => {
    const p = await parts(createXlsxFormatter(), ['A'], [[1]])
    expect(Object.keys(p)).toContain('xl/styles.xml')
    expect(p['[Content_Types].xml']).toContain('/xl/styles.xml')
    expect(p['xl/_rels/workbook.xml.rels']).toContain('Target="styles.xml"')
    expect(p['xl/styles.xml']).toContain('<cellXfs count="1">')
  })

  it('writes a Date as a serial number with a date numFmt style', async () => {
    const p = await parts(createXlsxFormatter({ dateFormat: 'dd/mm/yyyy' }), ['Data'], [[new Date('2026-03-14T00:00:00Z')]])
    // 2026-03-14 is day 46095 in Excel's 1900 date system
    expect(p['xl/worksheets/sheet1.xml']).toContain('<c r="A2" s="1"><v>46095</v></c>')
    expect(p['xl/styles.xml']).toContain('<numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>')
    expect(p['xl/styles.xml']).toContain('<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>')
  })

  it('keeps the time of day in the serial fraction', async () => {
    const p = await parts(createXlsxFormatter(), ['T'], [[new Date('2026-03-14T12:00:00Z')]])
    expect(p['xl/worksheets/sheet1.xml']).toContain('<v>46095.5</v>')
  })

  it("applies a column's number format to its numbers, one style per distinct code", async () => {
    const columns = [
      { header: 'Total', type: 'number' as const, format: '#,##0.00' },
      { header: 'Qty' },
      { header: 'Due', type: 'date' as const, format: 'dd/mm/yyyy' },
    ]
    const p = await parts(
      createXlsxFormatter(),
      ['Total', 'Qty', 'Due'],
      [
        [1408278.55, 3, new Date('2026-03-14T00:00:00Z')],
        [-12, 4, null],
      ],
      columns,
    )
    const sheet = p['xl/worksheets/sheet1.xml']!
    expect(sheet).toContain('<c r="A2" s="1"><v>1408278.55</v></c>')
    expect(sheet).toContain('<c r="A3" s="1"><v>-12</v></c>')
    expect(sheet).toContain('<c r="B2"><v>3</v></c>') // no format → unstyled
    expect(sheet).toContain('<c r="C2" s="2"><v>46095</v></c>')
    expect(sheet).toContain('<c r="C3"/>')
    expect(p['xl/styles.xml']).toContain('<numFmts count="2">')
    expect(p['xl/styles.xml']).toContain('formatCode="#,##0.00"')
  })

  it('keeps a date before 1900-03-01 as ISO text (outside what Excel serials represent correctly)', async () => {
    const p = await parts(
      createXlsxFormatter(),
      ['D'],
      [[new Date('1900-02-28T00:00:00Z')], [new Date('1850-01-01T00:00:00Z')], [new Date('1900-03-01T00:00:00Z')]],
    )
    const sheet = p['xl/worksheets/sheet1.xml']!
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">1900-02-28T00:00:00.000Z</t></is></c>')
    expect(sheet).toContain('<c r="A3" t="inlineStr"><is><t xml:space="preserve">1850-01-01T00:00:00.000Z</t></is></c>')
    expect(sheet).toContain('<c r="A4" s="1"><v>61</v></c>')
  })

  it('keeps the header row as text and a Date-branded object as text', async () => {
    const spoofed = Object.setPrototypeOf({ toISOString: () => 'spoof' }, Date.prototype)
    const p = await parts(createXlsxFormatter(), ['D'], [[spoofed]])
    expect(p['xl/worksheets/sheet1.xml']).toContain('<t xml:space="preserve">D</t>')
    expect(p['xl/worksheets/sheet1.xml']).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">spoof</t></is></c>')
  })

  it('freezes the header row with a pane', async () => {
    const p = await parts(createXlsxFormatter({ freezeHeader: true }), ['A'], [[1]])
    expect(p['xl/worksheets/sheet1.xml']).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>')
    expect((await parts(createXlsxFormatter(), ['A'], [[1]]))['xl/worksheets/sheet1.xml']).not.toContain('<pane')
  })

  it('writes column widths from options, falling back to the column hints', async () => {
    const p = await parts(createXlsxFormatter({ widths: [20] }), ['A', 'B', 'C'], [[1, 2, 3]], [
      { header: 'A', width: 5 },
      { header: 'B', width: 12 },
      { header: 'C' },
    ])
    const sheet = p['xl/worksheets/sheet1.xml']!
    expect(sheet).toContain(
      '<cols><col min="1" max="1" width="20" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/></cols>',
    )
    expect(sheet.indexOf('<cols>')).toBeLessThan(sheet.indexOf('<sheetData>'))
  })

  it('names the sheet (XML-escaped) and validates the name', async () => {
    const p = await parts(createXlsxFormatter({ sheetName: 'Facturas & NC' }), ['A'], [[1]])
    expect(p['xl/workbook.xml']).toContain('<sheet name="Facturas &amp; NC"')
    for (const bad of ['', 'a'.repeat(32), 'a/b', 'a[b]', 'x:y', 'a*', 'q?', 'b\\c', "'quoted'"]) {
      expect(() => createXlsxFormatter({ sheetName: bad })).toThrow(TypeError)
    }
    expect(() => createXlsxFormatter({ sheetName: 'a'.repeat(31) })).not.toThrow()
  })

  it('receives column metadata through Exports.run', async () => {
    const def = defineExport<{ total: number; at: Date }>({
      name: 'invoices',
      columns: [
        { header: 'Total', value: (r) => r.total, format: '#,##0.00', width: 14 },
        { header: 'Data', value: (r) => r.at, type: 'date' },
      ],
    })
    const result = await new Exports({
      formatters: [createXlsxFormatter({ sheetName: 'Facturas', freezeHeader: true, dateFormat: 'dd/mm/yyyy' })],
    }).run(def, [{ total: 10.5, at: new Date('2026-03-14T00:00:00Z') }], 'xlsx')
    const p = unzipStore(result.content)
    expect(p['xl/worksheets/sheet1.xml']).toContain('<c r="A2" s="1"><v>10.5</v></c>')
    expect(p['xl/worksheets/sheet1.xml']).toContain('<c r="B2" s="2"><v>46095</v></c>')
    expect(p['xl/worksheets/sheet1.xml']).toContain('width="14"')
  })

  it('leaves the default xlsxFormatter unchanged (no styles part, Dates as ISO text)', async () => {
    const p = unzipStore((await xlsxFormatter.render(['D'], [[new Date('2026-03-14T00:00:00Z')]])) as Buffer)
    expect(Object.keys(p)).not.toContain('xl/styles.xml')
    expect(p['xl/worksheets/sheet1.xml']).toContain('2026-03-14T00:00:00.000Z')
    expect(p['xl/workbook.xml']).toContain('<sheet name="Sheet1"')
  })
})
