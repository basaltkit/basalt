/** Test helpers for building raw multipart/form-data bodies (shared with the adapter parity matrix). */

export const BOUNDARY = '----basaltTestBoundary7MA4YWxk'

export type Part =
  | { name: string; value: string }
  /** `length` adds the part's own `Content-Length` header (rare, but legal). */
  | { name: string; filename: string; type?: string; data: string | Uint8Array; length?: number }
  | { raw: string }

/** Serialises parts into a multipart body. `{ raw }` injects bytes verbatim (for malformed cases). */
export function multipart(parts: Part[], options: { boundary?: string; close?: boolean } = {}): Buffer {
  const boundary = options.boundary ?? BOUNDARY
  const chunks: Buffer[] = []
  for (const part of parts) {
    if ('raw' in part) {
      chunks.push(Buffer.from(part.raw, 'utf8'))
      continue
    }
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    if ('filename' in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.type ?? 'application/octet-stream'}\r\n` +
            (part.length === undefined ? '' : `Content-Length: ${part.length}\r\n`) +
            '\r\n',
        ),
      )
      chunks.push(typeof part.data === 'string' ? Buffer.from(part.data) : Buffer.from(part.data))
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}`))
    }
    chunks.push(Buffer.from('\r\n'))
  }
  if (options.close !== false) chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

export const contentType = (boundary = BOUNDARY): string => `multipart/form-data; boundary=${boundary}`

/** Splits a buffer into chunks of `size` bytes (to exercise boundaries across chunk splits). */
export function chunked(body: Buffer, size: number): Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; i < body.length; i += size) out.push(body.subarray(i, i + size))
  return out
}

/** Reads a stream to a UTF-8 string. */
export async function text(stream: AsyncIterable<unknown>): Promise<string> {
  const parts: Buffer[] = []
  for await (const chunk of stream) parts.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(parts).toString('utf8')
}
