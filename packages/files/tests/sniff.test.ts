import { describe, expect, it } from 'vitest'
import {
  FileTypeMismatchError,
  FileTypeNotAllowedError,
  Files,
  normalizeContentType,
  sniffContentType,
  type FileValidation,
} from '../src/index.js'
import { corpus, fakeDisk } from './fixtures.js'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function setup(validate: FileValidation = { sniff: true }) {
  const { driver, disk } = fakeDisk()
  return { driver, files: new Files({ disk, validate }) }
}

describe('sniffContentType — signature table', () => {
  it.each([
    ['pdf', 'application/pdf'],
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['gif87', 'image/gif'],
    ['webp', 'image/webp'],
    ['tiffLE', 'image/tiff'],
    ['tiffBE', 'image/tiff'],
    ['zip', 'application/zip'],
    ['docx', DOCX],
    ['docxStreamed', DOCX],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['exe', 'application/x-msdownload'],
    ['elf', 'application/x-elf'],
    ['machO', 'application/x-mach-binary'],
    ['html', 'text/html'],
    ['svg', 'image/svg+xml'],
    ['svgWithProlog', 'image/svg+xml'],
    ['xml', 'application/xml'],
  ] as const)('%s → %s', (name, type) => {
    expect(sniffContentType(corpus[name])).toBe(type)
  })

  it('returns null for text it has no signature for — no false positive on a CSV starting with "MZ"', () => {
    expect(sniffContentType(corpus.text)).toBeNull()
    expect(sniffContentType(corpus.csv)).toBeNull()
    expect(sniffContentType(new Uint8Array())).toBeNull()
    expect(sniffContentType(Buffer.from('<abbr is prose, not a tag'))).toBeNull()
  })

  it('finds HTML behind a BOM and leading whitespace', () => {
    expect(sniffContentType(Buffer.from('﻿  \n\t<html><script>x</script>'))).toBe('text/html')
    expect(sniffContentType(Buffer.from('<SCRIPT>alert(1)</SCRIPT>'))).toBe('text/html')
  })

  it('normalizes aliases and parameters', () => {
    expect(normalizeContentType('Image/JPG; charset=binary')).toBe('image/jpeg')
    expect(normalizeContentType('application/x-zip-compressed')).toBe('application/zip')
  })
})

describe('BK-003 · validate.sniff checks the real type (hostile corpus)', () => {
  const mismatch = async (content: Buffer, contentType: string, name = 'upload') => {
    const { files, driver } = setup({ sniff: true, allowedTypes: ['application/pdf', 'image/*', DOCX] })
    const error = await files.upload(content, { name, contentType, tenantId: 'acme' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FileTypeMismatchError)
    expect((error as FileTypeMismatchError).code).toBe('FILE_TYPE_MISMATCH')
    expect((error as FileTypeMismatchError).status).toBe(415)
    expect(driver.files.size).toBe(0)
    return error as FileTypeMismatchError
  }

  it('html-named.pdf: an HTML page declared as application/pdf is refused', async () => {
    const error = await mismatch(corpus.html, 'application/pdf', 'html-named.pdf')
    expect(error.declared).toBe('application/pdf')
    expect(error.detected).toBe('text/html')
  })

  it('docx-as-pdf.pdf: a Word document declared as application/pdf is refused', async () => {
    expect((await mismatch(corpus.docx, 'application/pdf', 'docx-as-pdf.pdf')).detected).toBe(DOCX)
  })

  it('exe-as-jpg.jpg: an executable declared as image/jpeg is refused (PE, ELF, Mach-O)', async () => {
    await mismatch(corpus.exe, 'image/jpeg', 'exe-as-jpg.jpg')
    await mismatch(corpus.elf, 'image/jpeg')
    await mismatch(corpus.machO, 'image/jpeg')
  })

  it('svg-as-png: an SVG (scriptable) declared as image/png is refused', async () => {
    expect((await mismatch(corpus.svg, 'image/png', 'svg-as-png.png')).detected).toBe('image/svg+xml')
    await mismatch(corpus.svgWithProlog, 'image/png')
  })

  it('polyglot-ish: HTML with a PDF header further in is HTML, not PDF', async () => {
    await mismatch(Buffer.from('<html><body>hi</body></html>\n%PDF-1.7\n'), 'application/pdf')
    await mismatch(Buffer.from('  <script>alert(1)</script>'), 'text/plain')
  })

  it('polyglot-ish: bytes that start with a real signature are that format (served as it, never as HTML)', async () => {
    const { files } = setup({ sniff: true, allowedTypes: ['image/gif'] })
    const gifar = Buffer.concat([corpus.gif, Buffer.from('<script>alert(1)</script>')])
    const record = await files.upload(gifar, { name: 'a.gif', contentType: 'image/gif', tenantId: 'acme' })
    expect(record.contentType).toBe('image/gif')
  })

  it('truncated files that claim a signature type are refused (declared type unprovable)', async () => {
    expect((await mismatch(Buffer.from('%PD'), 'application/pdf')).detected).toBeNull()
    await mismatch(corpus.png.subarray(0, 4), 'image/png')
    await mismatch(Buffer.alloc(0), 'image/png')
    await mismatch(corpus.text, 'image/jpeg')
  })

  it('a plain ZIP declared as a Word document is refused', async () => {
    await mismatch(corpus.zip, DOCX)
  })

  it('the allowlist judges the DETECTED type, not the claim', async () => {
    const { files } = setup({ sniff: true, allowedTypes: ['image/*'] })
    // Honest octet-stream, but the content is a PDF — not an image.
    await expect(
      files.upload(corpus.pdf, { name: 'x', contentType: 'application/octet-stream', tenantId: 'acme' }),
    ).rejects.toBeInstanceOf(FileTypeNotAllowedError)
  })

  it('stores the detected type, keeps the declared one in metadata.declaredType, and puts with the detected type', async () => {
    const { files, driver } = setup({ sniff: true, allowedTypes: ['application/pdf'] })
    const record = await files.upload(corpus.pdf, {
      name: 'contract.pdf',
      contentType: 'application/octet-stream',
      tenantId: 'acme',
      metadata: { folder: 'legal', declaredType: 'forged' },
    })
    expect(record.contentType).toBe('application/pdf')
    expect(record.metadata).toEqual({ folder: 'legal', declaredType: 'application/octet-stream' })
    expect([...driver.types.values()][0]).toBe('application/pdf')
  })

  it('accepts honest uploads, aliases included, and text types it cannot sniff keep their declared type', async () => {
    const { files } = setup({ sniff: true })
    expect((await files.upload(corpus.jpeg, { name: 'a.jpg', contentType: 'image/jpg', tenantId: 'acme' })).contentType).toBe('image/jpeg')
    expect((await files.upload(corpus.docx, { name: 'a.docx', contentType: DOCX, tenantId: 'acme' })).contentType).toBe(DOCX)
    expect((await files.upload(corpus.docx, { name: 'a.zip', contentType: 'application/zip', tenantId: 'acme' })).contentType).toBe(DOCX)
    expect((await files.upload(corpus.csv, { name: 'a.csv', contentType: 'text/csv', tenantId: 'acme' })).contentType).toBe('text/csv')
    expect((await files.upload(corpus.svg, { name: 'a.svg', contentType: 'image/svg+xml', tenantId: 'acme' })).contentType).toBe('image/svg+xml')
  })

  it('a custom sniffer decides; null falls back to the declared type', async () => {
    const seen: number[] = []
    const { files } = setup({
      sniff: (head) => {
        seen.push(head.length)
        return head[0] === 0x21 ? 'application/x-bang' : null
      },
    })
    await expect(files.upload(Buffer.from('!!'), { name: 'x', contentType: 'image/png', tenantId: 'acme' })).rejects.toBeInstanceOf(
      FileTypeMismatchError,
    )
    // Unknown to the custom sniffer → declared type, even for a signature type.
    expect((await files.upload(corpus.text, { name: 'x', contentType: 'image/png', tenantId: 'acme' })).contentType).toBe('image/png')
    expect(seen).toEqual([2, corpus.text.length])
  })

  it('off by default: the declared type is trusted and no declaredType is recorded (unchanged behaviour)', async () => {
    const { files } = setup({ allowedTypes: ['application/pdf'] })
    const record = await files.upload(corpus.html, { name: 'html-named.pdf', contentType: 'application/pdf', tenantId: 'acme' })
    expect(record.contentType).toBe('application/pdf')
    expect(record.metadata).toBeUndefined()
  })
})
