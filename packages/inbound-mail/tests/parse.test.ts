import { describe, expect, it } from 'vitest'
import { InboundMailLimitError, InboundMailMalformedError, parseInbound, sanitizeAttachmentName } from '../src/index.js'
import { eml, fixture, nested, withAttachments } from './helpers.js'

describe('parseInbound', () => {
  it('reads a mixed/related/alternative message: bodies, attachments, inline cid, headers', async () => {
    const parsed = await parseInbound(fixture('invoice.eml'), { trustedAuthservIds: ['mx.cloudflare.net'] })
    expect(parsed.subject).toBe('Factura FT 2026/57 – outubro') // RFC 2047
    expect(parsed.from).toEqual({ name: 'Facturas Kilamba', address: 'facturas@kilamba.ao' })
    expect(parsed.to).toEqual([{ name: 'Invoices', address: 'acme@in.example.com' }, { address: 'other@example.org' }])
    expect(parsed.cc.map((a) => a.address)).toEqual(['a@example.org', 'b@example.org']) // group flattened
    expect(parsed.replyTo).toEqual([{ address: 'billing@kilamba.ao' }])
    expect(parsed.messageId).toBe('<ft-2026-57@kilamba.ao>')
    expect(parsed.inReplyTo).toBe('<order-1@example.com>')
    expect(parsed.references).toEqual(['<thread-0@example.com>', '<order-1@example.com>'])
    expect(parsed.date?.toISOString()).toBe('2026-10-01T10:00:00.000Z')
    expect(parsed.text).toContain('Olá, segue a factura.') // quoted-printable
    expect(parsed.html).toContain('<b>factura</b>')
    expect(parsed.truncated).toEqual({ text: false, html: false })

    const [logo, pdf, forwarded, ...rest] = parsed.attachments
    expect(rest).toEqual([])
    expect(logo).toMatchObject({ disposition: 'inline', contentId: '<logo@kilamba>', declaredContentType: 'image/png', filename: 'attachment-1' })
    expect(pdf).toMatchObject({ filename: 'factura nº 57.pdf', declaredContentType: 'application/pdf', disposition: 'attachment' }) // RFC 2231
    expect(Buffer.from(pdf!.content).subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf!.size).toBe(pdf!.content.byteLength)

    // The nested message is a raw attachment: its own parts are not recursed into.
    expect(forwarded).toMatchObject({ filename: 'forwarded.eml', declaredContentType: 'message/rfc822' })
    expect(Buffer.from(forwarded!.content).toString()).toContain('inner.bin')
    expect(parsed.attachments.some((a) => a.filename === 'inner.bin')).toBe(false)
    expect(parsed.text).not.toContain('inner body')

    // Top-level headers only, lower-cased names, document order.
    expect(parsed.headers[0]).toEqual({ name: 'return-path', value: '<bounce@kilamba.ao>' })
    expect(parsed.headers.some((h) => h.name === 'content-disposition')).toBe(false)
    expect(parsed.auth).toMatchObject({ authservId: 'mx.cloudflare.net', dmarc: 'pass', spf: 'pass', dkim: 'pass', dkimDomains: ['kilamba.ao'] })
  })

  it('decodes 8-bit Latin-1 and RFC 2047 ISO-8859-1', async () => {
    const parsed = await parseInbound(fixture('latin1-8bit.eml'))
    expect(parsed.from).toEqual({ name: 'José', address: 'jose@example.org' })
    expect(parsed.subject).toContain('olá')
    expect(parsed.text).toContain('Preço')
    expect(parsed.auth).toEqual({ spf: 'unknown', dkim: 'unknown', dmarc: 'unknown', dkimDomains: [] })
  })

  it('handles a minimal message without optional fields', async () => {
    const parsed = await parseInbound(eml(['Subject: x', 'Date: not a date'], 'hi'))
    expect(parsed.from).toBeUndefined()
    expect(parsed.messageId).toBeUndefined()
    expect(parsed.date).toBeUndefined()
    expect(parsed.html).toBeUndefined()
    expect(parsed.references).toEqual([])
    expect(parsed.text).toContain('hi')
  })

  it('rejects over maxRawBytes before parsing', async () => {
    const raw = eml(['Subject: x'], 'a'.repeat(100))
    const error = await parseInbound(raw, { maxRawBytes: 50 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InboundMailLimitError)
    expect(error).toMatchObject({ status: 422, code: 'INBOUND_MAIL_LIMIT', details: { limit: 'maxRawBytes', max: 50, value: raw.byteLength } })
  })

  it('rejects nesting over maxDepth and accepts it at the limit', async () => {
    await expect(parseInbound(nested(8))).resolves.toBeDefined()
    await expect(parseInbound(nested(12))).rejects.toMatchObject({ status: 422, details: { limit: 'maxDepth' } })
    await expect(parseInbound(nested(3), { maxDepth: 2 })).rejects.toMatchObject({ details: { limit: 'maxDepth', max: 2 } })
  })

  it('rejects an oversized header block', async () => {
    const raw = eml(['Subject: x', `X-Padding: ${'p'.repeat(70 * 1024)}`])
    await expect(parseInbound(raw)).rejects.toMatchObject({ status: 422, details: { limit: 'maxHeaderBytes', max: 64 * 1024 } })
  })

  it('enforces part, attachment-count, per-attachment and total limits', async () => {
    const three = withAttachments([{ name: 'a', content: 'aaaa' }, { name: 'b', content: 'bbbb' }, { name: 'c', content: 'cccc' }])
    await expect(parseInbound(three, { maxParts: 3 })).rejects.toMatchObject({ details: { limit: 'maxParts', max: 3, value: 4 } })
    await expect(parseInbound(three, { maxAttachments: 2 })).rejects.toMatchObject({ details: { limit: 'maxAttachments', value: 3 } })
    await expect(parseInbound(three, { maxAttachmentBytes: 3 })).rejects.toMatchObject({ details: { limit: 'maxAttachmentBytes', value: 4 } })
    await expect(parseInbound(three, { maxTotalAttachmentBytes: 10 })).rejects.toMatchObject({ details: { limit: 'maxTotalAttachmentBytes', value: 12 } })
    await expect(parseInbound(three)).resolves.toMatchObject({ attachments: [{ size: 4 }, { size: 4 }, { size: 4 }] })
  })

  it('truncates text and html at maxTextBytes without splitting a character, and flags it', async () => {
    const raw = Buffer.from(
      [
        'Subject: long',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="a"',
        '',
        '--a',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'ééééé',
        '--a',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>short</p>',
        '--a--',
        '',
      ].join('\r\n'),
    )
    const parsed = await parseInbound(raw, { maxTextBytes: 5 })
    expect(parsed.text).toBe('éé') // 4 bytes: a third é would split
    expect(parsed.html).toBe('<p>sh')
    expect(parsed.truncated).toEqual({ text: true, html: true })
  })

  it('validates its options', async () => {
    await expect(parseInbound(eml(['Subject: x']), { maxDepth: 0 })).rejects.toThrow(TypeError)
    await expect(parseInbound(eml(['Subject: x']), { maxParts: 1.5 })).rejects.toThrow(/maxParts/)
  })

  it('maps a parser failure to 400 INBOUND_MAIL_MALFORMED', async () => {
    // A detached view over a transferred buffer cannot be read by the parser.
    const buffer = new ArrayBuffer(8)
    const view = new Uint8Array(buffer)
    structuredClone(buffer, { transfer: [buffer] })
    const error = await parseInbound(view).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InboundMailMalformedError)
    expect(error).toMatchObject({ status: 400, code: 'INBOUND_MAIL_MALFORMED' })
  })
})

describe('sanitizeAttachmentName', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\x\\evil.exe', 'evil.exe'],
    ['invoice\u202Efdp.exe', 'invoicefdp.exe'],
    ['a\u0000b.pdf', 'ab.pdf'],
    ['..hidden', 'hidden'],
    ['', 'attachment-3'],
    ['   ', 'attachment-3'],
    [null, 'attachment-3'],
    ['../', 'attachment-3'],
  ])('%j → %j', (input, expected) => {
    expect(sanitizeAttachmentName(input, 2)).toBe(expected)
  })

  it('caps the name at 255 UTF-8 bytes without splitting a character', () => {
    const name = sanitizeAttachmentName(`${'ç'.repeat(300)}.pdf`, 0)
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255)
    expect(name).toBe('ç'.repeat(127))
  })

  it('is applied to parsed attachments', async () => {
    const parsed = await parseInbound(withAttachments([{ name: '../../etc/passwd', content: 'x' }, { content: 'y' }]))
    expect(parsed.attachments.map((a) => a.filename)).toEqual(['passwd', 'attachment-2'])
  })
})
