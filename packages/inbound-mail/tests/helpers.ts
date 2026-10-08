import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** A fixture's exact bytes. */
export const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

/** Builds a message from header lines and a body, CRLF-terminated. */
export const eml = (headers: readonly string[], body = 'hello'): Buffer =>
  Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}\r\n`, 'utf8')

/** A multipart/mixed message with the given attachments. */
export function withAttachments(attachments: ReadonlyArray<{ name?: string; type?: string; content: Buffer | string; inline?: boolean }>): Buffer {
  const parts = attachments.map((attachment) => {
    const content = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content)
    const disposition = attachment.inline ? 'inline' : 'attachment'
    const filename = attachment.name === undefined ? '' : `; filename="${attachment.name}"`
    return [
      '--b',
      `Content-Type: ${attachment.type ?? 'application/octet-stream'}`,
      `Content-Disposition: ${disposition}${filename}`,
      'Content-Transfer-Encoding: base64',
      '',
      content.toString('base64').replace(/(.{76})/g, '$1\r\n'),
    ].join('\r\n')
  })
  return Buffer.from(
    [
      'From: a@example.org',
      'To: acme@in.example.com',
      'Subject: attachments',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: text/plain',
      '',
      'see attached',
      ...parts,
      '--b--',
      '',
    ].join('\r\n'),
    'utf8',
  )
}

/** A message nested `depth` multiparts deep. */
export function nested(depth: number): Buffer {
  let body = 'Content-Type: text/plain\r\n\r\ndeep\r\n'
  for (let level = depth; level >= 1; level--) {
    body = `Content-Type: multipart/mixed; boundary="l${level}"\r\n\r\n--l${level}\r\n${body}--l${level}--\r\n`
  }
  return Buffer.from(`From: a@example.org\r\nTo: acme@in.example.com\r\nSubject: deep\r\nMIME-Version: 1.0\r\n${body}`, 'utf8')
}
