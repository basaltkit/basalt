import { Readable } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import { Container } from '@basaltkit/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  HttpError,
  generateOpenApi,
  route,
  runRoute,
  sanitizeFilename,
  toErrorResponse,
  upload,
  type BasaltRoute,
  type RouteGuard,
  type UploadOptions,
} from '../src/index.js'
import { BOUNDARY, chunked, contentType, multipart, text } from './multipart-fixtures.js'
import { FakeReply, makeRequest } from './support.js'

/** A byte stream that counts how many chunks were pulled from it. */
function source(chunks: Buffer[], end: 'end' | 'abort' | 'hang' = 'end') {
  let index = 0
  const stats = { pulls: 0 }
  // highWaterMark 1: the stream buffers no more than one chunk ahead, so
  // `pulls` measures what the parser actually asked for.
  const stream = new Readable({
    highWaterMark: 1,
    read() {
      stats.pulls += 1
      if (index < chunks.length) this.push(chunks[index++])
      else if (end === 'end') this.push(null)
      else if (end === 'abort') this.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    },
  })
  return { stream, stats }
}

interface Received {
  fields: Record<string, string>
  files: { field: string; filename: string; declaredType: string; content: string }[]
}

/** A route that reads every file fully and returns what it saw. */
const collecting = (options: Partial<UploadOptions> = {}) =>
  route({
    method: 'POST',
    url: '/upload',
    body: upload({ maxBytes: 1024 * 1024, maxFiles: 5, ...options }),
    async handler({ body }): Promise<Received> {
      const files: Received['files'] = []
      for await (const file of body.files) {
        files.push({ field: file.field, filename: file.filename, declaredType: file.declaredType, content: await text(file.stream) })
      }
      return { fields: { ...body.fields }, files }
    },
  })

async function run(
  definition: BasaltRoute,
  body: Readable | undefined,
  headers: Record<string, string> = { 'content-type': contentType() },
  guards: RouteGuard[] = [],
) {
  const reply = new FakeReply()
  const request = makeRequest({ method: 'POST', url: '/upload', headers, ...(body ? { bodyStream: body } : {}) })
  try {
    const result = await runRoute(definition, request, reply, { container: new Container(), guards })
    return { status: reply.statusCode, result: result as Received, reply, code: undefined as string | undefined }
  } catch (error) {
    const mapped = toErrorResponse(error)
    return { status: mapped.status, result: undefined, reply, code: mapped.body.error.code, message: mapped.body.error.message }
  }
}

const sample = multipart([
  { name: 'title', value: 'Quarterly report' },
  { name: 'doc', filename: 'report.pdf', type: 'application/pdf', data: '%PDF-1.7\r\n--not-a-boundary\r\nbody\r\n' },
  { name: 'note', value: 'after the file' },
  { name: 'img', filename: 'a.png', type: 'image/png', data: new Uint8Array([0, 1, 2, 13, 10, 45, 45, 255]) },
])

describe('upload() — streaming multipart parsing (BK-006)', () => {
  it('parses fields and files identically whatever the chunk boundaries', async () => {
    const expected = await run(collecting(), source([sample]).stream)
    expect(expected.status).toBe(200)
    expect(expected.result!.fields).toEqual({ title: 'Quarterly report', note: 'after the file' })
    expect(expected.result!.files.map((f) => [f.field, f.filename, f.declaredType])).toEqual([
      ['doc', 'report.pdf', 'application/pdf'],
      ['img', 'a.png', 'image/png'],
    ])
    expect(expected.result!.files[0]!.content).toBe('%PDF-1.7\r\n--not-a-boundary\r\nbody\r\n')
    for (const size of [1, 2, 3, 5, 7, 11, 13, 31, 64, 257]) {
      const got = await run(collecting(), source(chunked(sample, size)).stream)
      expect(got.result, `chunk size ${size}`).toEqual(expected.result)
    }
  })

  it('keeps binary content byte-exact, including CRLF and partial delimiters', async () => {
    const tricky = Buffer.from(`\r\n--${BOUNDARY.slice(0, -1)}\r\n--\r\n\r\n`)
    const exact = route({
      method: 'POST',
      url: '/upload',
      body: upload({ maxBytes: 4096, maxFiles: 1 }),
      async handler({ body }) {
        for await (const file of body.files) {
          const chunks: Buffer[] = []
          for await (const c of file.stream) chunks.push(c as Buffer)
          return { equal: Buffer.concat(chunks).equals(tricky) }
        }
        return { equal: false }
      },
    })
    for (const size of [1, 3, 8, 1000]) {
      const got = await run(exact, source(chunked(multipart([{ name: 'f', filename: 'x.bin', data: tricky }]), size)).stream)
      expect(got.result).toEqual({ equal: true })
    }
  })

  it('exposes fields sent before a file when that file is yielded', async () => {
    const seen: string[] = []
    const r = route({
      method: 'POST',
      url: '/upload',
      body: upload({ maxBytes: 4096, maxFiles: 2 }),
      async handler({ body }) {
        for await (const file of body.files) {
          seen.push(`${file.filename}:${body.fields['title'] ?? '-'}`)
          file.stream.resume()
        }
        return null
      },
    })
    await run(r, source([sample]).stream)
    expect(seen).toEqual(['report.pdf:Quarterly report', 'a.png:Quarterly report'])
  })

  it('skips an unread file when the next one is requested', async () => {
    const r = route({
      method: 'POST',
      url: '/upload',
      body: upload({ maxBytes: 4096, maxFiles: 2 }),
      async handler({ body }) {
        const names: string[] = []
        for await (const file of body.files) names.push(file.filename) // never reads a stream
        return { names, fields: { ...body.fields } }
      },
    })
    const got = await run(r, source(chunked(sample, 7)).stream)
    expect(got.result).toEqual({ names: ['report.pdf', 'a.png'], fields: { title: 'Quarterly report', note: 'after the file' } })
  })

  it('ignores the empty part a browser sends for a blank file input', async () => {
    const got = await run(
      collecting({ maxFiles: 1 }),
      source([multipart([{ name: 'blank', filename: '', data: '' }, { name: 'f', filename: 'a.txt', data: 'hi' }])]).stream,
    )
    expect(got.result!.files).toEqual([{ field: 'f', filename: 'a.txt', declaredType: 'application/octet-stream', content: 'hi' }])
  })

  it('decodes RFC 8187 filename* over filename', async () => {
    const body = multipart([
      {
        raw:
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="f"; filename="fallback.txt"; filename*=UTF-8''na%C3%AFve%20r%C3%A9sum%C3%A9.txt\r\n\r\n` +
          'x\r\n',
      },
    ])
    const got = await run(collecting(), source([body]).stream)
    expect(got.result!.files[0]!.filename).toBe('naïve résumé.txt')
  })

  it('never lets a field named __proto__ pollute the fields object', async () => {
    let proto: unknown = 'unset'
    const r = route({
      method: 'POST',
      url: '/upload',
      body: upload({ maxBytes: 4096, maxFiles: 1 }),
      async handler({ body }) {
        for await (const file of body.files) file.stream.resume()
        proto = Object.getPrototypeOf(body.fields)
        return { value: body.fields['__proto__'] }
      },
    })
    const got = await run(r, source([multipart([{ name: '__proto__', value: 'polluted' }])]).stream)
    expect(got.result).toEqual({ value: 'polluted' })
    expect(proto).toBeNull()
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe('upload() — request framing', () => {
  it('415 for a non-multipart content type, and when there is none', async () => {
    expect((await run(collecting(), source([Buffer.from('{}')]).stream, { 'content-type': 'application/json' })).status).toBe(415)
    expect((await run(collecting(), source([Buffer.from('{}')]).stream, {})).status).toBe(415)
    expect((await run(collecting(), source([sample]).stream, { 'content-type': `multipart/mixed; boundary=${BOUNDARY}` })).status).toBe(415)
  })

  it('400 for a missing, empty, over-long or invalid boundary', async () => {
    for (const header of [
      'multipart/form-data',
      'multipart/form-data; boundary=',
      'multipart/form-data; boundary=""',
      `multipart/form-data; boundary=${'a'.repeat(71)}`,
      'multipart/form-data; boundary=bad\u0000byte',
      'multipart/form-data; boundary="ends-with-space "',
      'multipart/form-data; boundary="unterminated',
    ]) {
      const got = await run(collecting(), source([sample]).stream, { 'content-type': header })
      expect(got.status, header).toBe(400)
      expect(got.code).toBe('MALFORMED_MULTIPART')
    }
  })

  it('400 on boundary injection: a repeated boundary parameter is refused, not guessed', async () => {
    const got = await run(collecting(), source([sample]).stream, {
      'content-type': `multipart/form-data; boundary=${BOUNDARY}; boundary=evil`,
    })
    expect(got.status).toBe(400)
  })

  it('400 when content carries a longer boundary sharing ours as a prefix', async () => {
    const body = multipart([{ raw: `--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"\r\n\r\nv\r\n--${BOUNDARY}X\r\n` }])
    expect((await run(collecting(), source([body]).stream)).status).toBe(400)
  })

  it('accepts a quoted boundary', async () => {
    const got = await run(collecting(), source([sample]).stream, { 'content-type': `multipart/form-data; boundary="${BOUNDARY}"` })
    expect(got.status).toBe(200)
  })
})

describe('upload() — hostile parts', () => {
  const part = (headers: string, content = 'x') => multipart([{ raw: `--${BOUNDARY}\r\n${headers}\r\n\r\n${content}\r\n` }])

  it('400 on part headers larger than maxHeaderBytes (never buffered unbounded)', async () => {
    const huge = part(`Content-Disposition: form-data; name="a"\r\nX-Pad: ${'p'.repeat(20_000)}`)
    const got = await run(collecting(), source(chunked(huge, 512)).stream)
    expect(got.status).toBe(400)
    // And a header block that never ends is cut off at the limit too.
    const endless = Buffer.concat([Buffer.from(`--${BOUNDARY}\r\nX-Pad: `), Buffer.alloc(100_000, 0x61)])
    expect((await run(collecting(), source(chunked(endless, 1024), 'hang').stream)).status).toBe(400)
  })

  it('400 on too many header lines, folded headers, or a duplicated header', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `X-H${i}: v`).join('\r\n')
    for (const headers of [
      `Content-Disposition: form-data; name="a"\r\n${many}`,
      'Content-Disposition: form-data;\r\n name="a"',
      'Content-Disposition: form-data; name="a"\r\nContent-Disposition: form-data; name="b"',
      'Content-Disposition: form-data; name="a"; filename="x"; filename="y"',
      'Content-Disposition: attachment; name="a"',
      'Content-Disposition: form-data',
      'Content-Type: text/plain',
      'Content-Disposition: form-data; name="a"; filename="x"\r\nContent-Transfer-Encoding: base64',
    ]) {
      const got = await run(collecting(), source([part(headers)]).stream)
      expect(got.status, headers).toBe(400)
    }
  })

  it('400 on a nested multipart part', async () => {
    const nested = part(
      'Content-Disposition: form-data; name="files"; filename="a"\r\nContent-Type: multipart/mixed; boundary=inner',
      '--inner\r\nContent-Disposition: file; filename="evil.txt"\r\n\r\nx\r\n--inner--',
    )
    const got = await run(collecting(), source([nested]).stream)
    expect(got.status).toBe(400)
  })

  it('reduces path-traversal and hostile filenames to a safe basename', async () => {
    const names: [string, string][] = [
      ['../../x', 'x'],
      ['..\\..\\windows\\system32\\evil.exe', 'evil.exe'],
      ['C:\\x', 'x'],
      ['C:x.txt', 'x.txt'],
      ['/etc/passwd', 'passwd'],
      ['a\u0000b.txt', 'ab.txt'],
      ['..', 'file'],
      ['.', 'file'],
      ['   ', 'file'],
      ['invoice\u202Etxt.exe', 'invoicetxt.exe'],
      ['report.pdf. . ', 'report.pdf'],
    ]
    for (const [raw, safe] of names) expect(sanitizeFilename(raw), JSON.stringify(raw)).toBe(safe)
    expect(Buffer.byteLength(sanitizeFilename(`${'é'.repeat(300)}.pdf`))).toBeLessThanOrEqual(255)
    expect(sanitizeFilename(`${'a'.repeat(400)}.pdf`).endsWith('.pdf')).toBe(true)

    // End-to-end: the handler only ever sees the sanitised name (a NUL smuggled
    // percent-encoded in filename* is stripped too).
    const body = multipart([
      { name: 'a', filename: '../../x', data: '1' },
      { name: 'b', filename: 'C:\\x', data: '2' },
      { raw: `--${BOUNDARY}\r\nContent-Disposition: form-data; name="c"; filename*=UTF-8''..%2F..%2Fnul%00.sh\r\n\r\n3\r\n` },
    ])
    const got = await run(collecting(), source([body]).stream)
    expect(got.result!.files.map((f) => f.filename)).toEqual(['x', 'x', 'nul.sh'])

    // A raw NUL byte in a part header is refused outright.
    const raw = multipart([{ raw: `--${BOUNDARY}\r\nContent-Disposition: form-data; name="c"; filename="nul\u0000.sh"\r\n\r\n3\r\n` }])
    expect((await run(collecting(), source([raw]).stream)).status).toBe(400)
  })
})

describe('upload() — limits', () => {
  it('413 up front when Content-Length exceeds maxBytes, without reading the body', async () => {
    const { stream, stats } = source([sample])
    const got = await run(collecting({ maxBytes: 100 }), stream, { 'content-type': contentType(), 'content-length': String(sample.length) })
    expect(got.status).toBe(413)
    expect(stats.pulls).toBe(0)
    expect(got.reply.headers['connection']).toBe('close')
  })

  it('413 on the bytes actually received when no length is declared', async () => {
    const big = multipart([{ name: 'f', filename: 'big.bin', data: Buffer.alloc(50_000, 1) }])
    const got = await run(collecting({ maxBytes: 10_000 }), source(chunked(big, 4096)).stream)
    expect(got.status).toBe(413)
    expect(got.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('stops pulling the transport once a limit is hit', async () => {
    const big = multipart([{ name: 'f', filename: 'big.bin', data: Buffer.alloc(1_000_000, 1) }])
    const { stream, stats } = source(chunked(big, 1000))
    const got = await run(collecting({ maxBytes: 5_000 }), stream)
    expect(got.status).toBe(413)
    await tick()
    await tick()
    expect(stats.pulls).toBeLessThan(20)
  })

  it('413 when one file exceeds maxFileBytes', async () => {
    const body = multipart([{ name: 'f', filename: 'a', data: 'x'.repeat(200) }])
    expect((await run(collecting({ maxFileBytes: 100 }), source([body]).stream)).status).toBe(413)
  })

  it('400 TOO_MANY_FILES past maxFiles', async () => {
    const body = multipart([
      { name: 'f', filename: 'a', data: '1' },
      { name: 'f', filename: 'b', data: '2' },
    ])
    const got = await run(collecting({ maxFiles: 1 }), source([body]).stream)
    expect(got.status).toBe(400)
    expect(got.code).toBe('TOO_MANY_FILES')
  })

  it('400 TOO_MANY_FIELDS past maxFields, 413 on an oversized field', async () => {
    const many = multipart(Array.from({ length: 4 }, (_, i) => ({ name: `f${i}`, value: 'v' })))
    const tooMany = await run(collecting({ maxFields: 3 }), source([many]).stream)
    expect([tooMany.status, tooMany.code]).toEqual([400, 'TOO_MANY_FIELDS'])
    const bigField = multipart([{ name: 'f', value: 'v'.repeat(100) }])
    expect((await run(collecting({ maxFieldBytes: 50 }), source([bigField]).stream)).status).toBe(413)
  })

  it('415 for a file type outside allowedTypes; wildcards match subtypes', async () => {
    const png = multipart([{ name: 'f', filename: 'a.png', type: 'image/png', data: 'x' }])
    const html = multipart([{ name: 'f', filename: 'a.html', type: 'text/html', data: '<script>' }])
    const got = await run(collecting({ allowedTypes: ['image/*', 'application/pdf'] }), source([html]).stream)
    expect([got.status, got.code]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE'])
    expect((await run(collecting({ allowedTypes: ['image/*'] }), source([png]).stream)).status).toBe(200)
    expect((await run(collecting({ allowedTypes: ['IMAGE/PNG'] }), source([png]).stream)).status).toBe(200)
  })

  it('rejects invalid limits when the route is defined', () => {
    expect(() => upload({ maxBytes: 0, maxFiles: 1 })).toThrow(TypeError)
    expect(() => upload({ maxBytes: 10, maxFiles: -1 })).toThrow(TypeError)
    expect(() => upload({ maxBytes: Number.NaN, maxFiles: 1 })).toThrow(TypeError)
    expect(() => upload({ maxBytes: 10, maxFiles: 1, maxFieldBytes: 1.5 })).toThrow(TypeError)
  })
})

describe('upload() — the stream ends early or is never consumed', () => {
  it('400 when the body ends before the closing boundary (truncated upload)', async () => {
    const truncated = multipart([{ name: 'f', filename: 'a', data: 'partial' }], { close: false })
    const got = await run(collecting(), source(chunked(truncated, 5)).stream)
    expect([got.status, got.code]).toEqual([400, 'MALFORMED_MULTIPART'])
  })

  it('400 when the client aborts mid-upload', async () => {
    const got = await run(collecting(), source([sample.subarray(0, 150)], 'abort').stream)
    expect(got.status).toBe(400)
  })

  it('400 for an empty body', async () => {
    expect((await run(collecting(), source([]).stream)).status).toBe(400)
  })

  it('does not hang when the handler never touches the body: the rest is drained, connection closed', async () => {
    const { stream } = source(chunked(sample, 16))
    const r = route({
      method: 'POST',
      url: '/upload',
      body: upload({ maxBytes: 4096, maxFiles: 5 }),
      handler: () => ({ ignored: true }),
    })
    const got = await run(r, stream)
    expect(got.status).toBe(200)
    expect(got.reply.headers['connection']).toBe('close')
    for (let i = 0; i < 50 && !stream.readableEnded; i++) await tick()
    expect(stream.readableEnded).toBe(true)
  })

  it('does not hang when the handler reads only the first file and returns', async () => {
    const { stream } = source(chunked(sample, 16))
    const r = route({
      method: 'POST',
      url: '/upload',
      body: upload({ maxBytes: 4096, maxFiles: 5 }),
      async handler({ body }) {
        for await (const file of body.files) return { first: await text(file.stream) }
        return null
      },
    })
    const got = await run(r, stream)
    expect(got.result).toEqual({ first: '%PDF-1.7\r\n--not-a-boundary\r\nbody\r\n' })
    for (let i = 0; i < 50 && !stream.readableEnded; i++) await tick()
    expect(stream.readableEnded).toBe(true)
  })

  it('drains at most maxBytes of an abandoned upload, then stops pulling', async () => {
    const big = multipart([{ name: 'f', filename: 'big.bin', data: Buffer.alloc(1_000_000, 1) }])
    const { stream, stats } = source(chunked(big, 1000))
    const r = route({
      method: 'POST',
      url: '/upload',
      body: upload({ maxBytes: 10_000, maxFiles: 1 }),
      handler: () => 'ignored',
    })
    await run(r, stream)
    for (let i = 0; i < 100; i++) await tick()
    expect(stats.pulls).toBeLessThan(30)
    expect(stream.destroyed).toBe(false) // left to the server to close — the response still goes out
  })

  it('does not read ahead of a consumer that is not reading (backpressure)', async () => {
    const big = multipart([{ name: 'f', filename: 'big.bin', data: Buffer.alloc(2_000_000, 1) }])
    const { stream, stats } = source(chunked(big, 64 * 1024))
    let pullsWhileIdle = -1
    const r = route({
      method: 'POST',
      url: '/upload',
      body: upload({ maxBytes: 4_000_000, maxFiles: 1 }),
      async handler({ body }) {
        for await (const file of body.files) {
          for (let i = 0; i < 20; i++) await tick()
          pullsWhileIdle = stats.pulls
          return { size: (await text(file.stream)).length }
        }
        return null
      },
    })
    const got = await run(r, stream)
    expect(got.result).toEqual({ size: 2_000_000 })
    expect(pullsWhileIdle).toBeLessThan(5)
  })
})

describe('upload() — the pipeline runs before any body byte is read', () => {
  it('a rejecting guard (auth) answers without the parser touching the body', async () => {
    const { stream, stats } = source([sample])
    let handled = false
    let pullsSeenByGuard = -1
    const guard: RouteGuard = () => {
      pullsSeenByGuard = stats.pulls
      throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in.')
    }
    const r = route({
      method: 'POST',
      url: '/upload',
      body: upload({ maxBytes: 4096, maxFiles: 1 }),
      handler: () => {
        handled = true
      },
    })
    const got = await run(r, stream, { 'content-type': contentType() }, [guard])
    expect(got.status).toBe(401)
    expect(handled).toBe(false)
    expect(pullsSeenByGuard).toBe(0)
    expect(got.reply.headers['connection']).toBe('close')
  })

  it('checks the framing only after guards passed (an anonymous caller learns nothing about limits)', async () => {
    const guard: RouteGuard = () => {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in.')
    }
    const got = await run(collecting(), source([sample]).stream, { 'content-type': 'text/plain' }, [guard])
    expect(got.status).toBe(401)
  })

  it('400 when the adapter provides no body stream (e.g. invoked as an MCP tool)', async () => {
    expect((await run(collecting(), undefined)).status).toBe(400)
  })

  it('still validates query and params on an upload route', async () => {
    const r = route({
      method: 'POST',
      url: '/upload',
      query: z.object({ folder: z.string().min(1) }),
      body: upload({ maxBytes: 4096, maxFiles: 1 }),
      handler: () => 'ok',
    })
    expect((await run(r, source([sample]).stream)).status).toBe(400)
  })
})

describe('upload() in OpenAPI', () => {
  it('documents an upload route as multipart/form-data', () => {
    const doc = generateOpenApi([{ method: 'POST', url: '/upload', body: collecting().body! }], { title: 't', version: '1' }) as {
      paths: Record<string, Record<string, { requestBody?: { content: Record<string, unknown> } }>>
    }
    const content = doc.paths['/upload']!['post']!.requestBody!.content
    expect(Object.keys(content)).toEqual(['multipart/form-data'])
  })
})

describe('upload() over a web ReadableStream (Hono, Bun, Deno, edge)', () => {
  const webStream = (chunks: Buffer[]) =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift()
        if (next) controller.enqueue(new Uint8Array(next))
        else controller.close()
      },
    })

  async function runWeb(definition: BasaltRoute, stream: ReadableStream<Uint8Array>) {
    const reply = new FakeReply()
    const request = makeRequest({ method: 'POST', url: '/upload', headers: { 'content-type': contentType() }, bodyStream: stream })
    try {
      return { status: 200, result: (await runRoute(definition, request, reply, {})) as Received }
    } catch (error) {
      return { status: toErrorResponse(error).status, result: undefined }
    }
  }

  it('parses the same body from a web stream', async () => {
    const got = await runWeb(collecting(), webStream(chunked(sample, 9)))
    expect(got.result!.files.map((f) => f.filename)).toEqual(['report.pdf', 'a.png'])
    expect(got.result!.fields).toEqual({ title: 'Quarterly report', note: 'after the file' })
  })

  it('400 when the stream was already consumed (locked) by someone else', async () => {
    const stream = webStream([sample])
    stream.getReader()
    expect((await runWeb(collecting(), stream)).status).toBe(400)
  })

  it('drains an unread web stream after the handler returns', async () => {
    let pulled = 0
    const chunks = chunked(sample, 16)
    const total = chunks.length
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks.shift()
        if (next) {
          pulled += 1
          controller.enqueue(new Uint8Array(next))
        } else controller.close()
      },
    })
    const r = route({ method: 'POST', url: '/upload', body: upload({ maxBytes: 4096, maxFiles: 5 }), handler: () => 'ok' })
    expect((await runWeb(r, stream)).status).toBe(200)
    for (let i = 0; i < 100 && pulled < total; i++) await tick()
    expect(pulled).toBe(total)
  })
})
