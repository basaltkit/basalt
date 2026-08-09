import { describe, expect, it } from 'vitest'
import { Exports, defineExport } from '@basaltkit/exports'
import { xlsxFormatter } from '../src/index.js'

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
