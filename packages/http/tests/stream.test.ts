import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  contentDisposition,
  destroyStreamSource,
  isStreamResponse,
  nodeStreamFrom,
  openStreamPump,
  stream,
  streamPayloadOf,
  streamPump,
  toNodeStream,
  webStreamFrom,
  type StreamSource,
} from '../src/stream.js'

const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text))

const webStreamOf = (...chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift()
      if (next === undefined) controller.close()
      else controller.enqueue(bytes(next))
    },
  })

async function* iterableOf(...chunks: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield (typeof chunk === 'string' ? bytes(chunk) : chunk)
}

const readAll = async (source: StreamSource): Promise<string> => {
  const parts: Buffer[] = []
  for await (const chunk of toNodeStream(source)) parts.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(parts).toString('utf8')
}

describe('stream() — the response marker', () => {
  it('defaults to a 200 octet-stream and carries the source untouched', () => {
    const source = Readable.from(['a'])
    const response = stream(source)
    expect(isStreamResponse(response)).toBe(true)
    expect(streamPayloadOf(response)).toEqual({
      source,
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })
  })

  it('is not mistaken for a plain handler result', () => {
    expect(isStreamResponse({ a: 1 })).toBe(false)
    expect(isStreamResponse(null)).toBe(false)
    expect(isStreamResponse('stream')).toBe(false)
  })

  it('builds Content-Length, Content-Disposition and extra headers', () => {
    const payload = streamPayloadOf(
      stream(Readable.from([]), {
        status: 206,
        contentType: 'application/pdf',
        contentLength: 1234,
        filename: 'report.pdf',
        headers: { 'Cache-Control': 'private, max-age=0', 'X-Trace': 'abc' },
      }),
    )
    expect(payload.status).toBe(206)
    expect(payload.headers).toEqual({
      'content-type': 'application/pdf',
      'content-length': '1234',
      'content-disposition': 'attachment; filename="report.pdf"',
      'cache-control': 'private, max-age=0',
      'x-trace': 'abc',
    })
  })

  it('never lets a header value split the response', () => {
    const payload = streamPayloadOf(
      stream(Readable.from([]), {
        contentType: 'text/plain\r\nX-Injected: yes',
        headers: { 'x-note': 'line\none\u0000two' },
      }),
    )
    expect(payload.headers['content-type']).toBe('text/plainX-Injected: yes')
    expect(payload.headers['x-note']).toBe('lineonetwo')
  })

  it('ignores a Content-Length that is not a real byte count', () => {
    for (const contentLength of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2]) {
      expect(streamPayloadOf(stream(Readable.from([]), { contentLength })).headers).not.toHaveProperty('content-length')
    }
    expect(streamPayloadOf(stream(Readable.from([]), { contentLength: 0 })).headers['content-length']).toBe('0')
  })

  it('skips a header whose value is nullish rather than writing "undefined"', () => {
    const headers = { 'x-kept': 'yes', 'x-dropped': undefined } as unknown as Record<string, string>
    expect(streamPayloadOf(stream(Readable.from([]), { headers })).headers).not.toHaveProperty('x-dropped')
  })
})

describe('contentDisposition()', () => {
  it('quotes a plain ASCII name with no RFC 5987 parameter', () => {
    expect(contentDisposition('invoice-2026.pdf')).toBe('attachment; filename="invoice-2026.pdf"')
  })

  it('honours inline, and anything else is an attachment', () => {
    expect(contentDisposition('a.png', 'inline')).toBe('inline; filename="a.png"')
    expect(contentDisposition('a.png', 'attachment')).toBe('attachment; filename="a.png"')
  })

  it('strips directories and drive letters — a filename is never a path', () => {
    expect(contentDisposition('../../etc/passwd')).toBe('attachment; filename="passwd"')
    expect(contentDisposition('C:\\Users\\x\\scan.png')).toBe('attachment; filename="scan.png"')
  })

  it('adds filename* when the ASCII form lost something, escaping every non attr-char', () => {
    expect(contentDisposition('relatório.pdf')).toBe(
      `attachment; filename="relat_rio.pdf"; filename*=UTF-8''relat%C3%B3rio.pdf`,
    )
    // A quote would end the quoted-string. (A backslash never survives: it is a
    // path separator, so `sanitizeFilename` treats what follows it as the name.)
    expect(contentDisposition('a"b.txt')).toBe(`attachment; filename="a_b.txt"; filename*=UTF-8''a%22b.txt`)
    expect(contentDisposition('a\\b.txt')).toBe('attachment; filename="b.txt"')
    // Printable ASCII survives intact, so no `filename*` is added — but the
    // characters RFC 5987 forbids in an ext-value are escaped when one is.
    expect(contentDisposition("it's (a)*.txt")).toBe(`attachment; filename="it's (a)*.txt"`)
    expect(contentDisposition("it's (á)*.txt")).toBe(
      `attachment; filename="it's (_)*.txt"; filename*=UTF-8''it%27s%20%28%C3%A1%29%2A.txt`,
    )
  })

  it('falls back to "file" when nothing usable is left', () => {
    expect(contentDisposition('../')).toBe('attachment; filename="file"')
  })
})

describe('toNodeStream()', () => {
  it('passes a Node Readable through untouched', () => {
    const source = Readable.from(['x'])
    expect(toNodeStream(source)).toBe(source)
  })

  it('reads a web ReadableStream and an async iterable alike', async () => {
    expect(await readAll(webStreamOf('he', 'llo'))).toBe('hello')
    expect(await readAll(iterableOf('he', 'llo'))).toBe('hello')
  })
})

describe('destroyStreamSource()', () => {
  it('destroys a Readable, cancels a web stream, returns an iterator', async () => {
    const readable = Readable.from(['x'])
    destroyStreamSource(readable)
    expect(readable.destroyed).toBe(true)

    const web = webStreamOf('x')
    destroyStreamSource(web)
    await Promise.resolve()
    expect(await web.getReader().read()).toEqual({ done: true, value: undefined })

    let returned = false
    const iterable = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: bytes('x') }),
        return: async () => {
          returned = true
          return { done: true as const, value: undefined }
        },
      }),
    }
    destroyStreamSource(iterable)
    await Promise.resolve()
    expect(returned).toBe(true)
  })

  it('never throws, whatever the source does', () => {
    const hostile = {
      get [Symbol.asyncIterator]() {
        throw new Error('nope')
      },
    } as unknown as StreamSource
    expect(() => destroyStreamSource(hostile)).not.toThrow()
  })
})

describe('streamPump()', () => {
  it('pulls a Node Readable chunk by chunk and destroys it on close', async () => {
    const source = Readable.from([bytes('a'), bytes('b')])
    const pump = streamPump(source)
    expect(Buffer.from((await pump.next())!).toString()).toBe('a')
    await pump.close()
    expect(pump.closed).toBe(true)
    expect(source.destroyed).toBe(true)
    // Idempotent: closing twice is a no-op, not a second destroy.
    await expect(pump.close()).resolves.toBeUndefined()
  })

  it('coerces string chunks to bytes and reports the end as null', async () => {
    const pump = streamPump(Readable.from(['ab'], { objectMode: true }) as unknown as StreamSource)
    expect(Buffer.from((await pump.next())!).toString()).toBe('ab')
    expect(await pump.next()).toBeNull()
  })

  it('reads and cancels a web ReadableStream', async () => {
    const web = webStreamOf('a', 'b')
    const pump = streamPump(web)
    expect(Buffer.from((await pump.next())!).toString()).toBe('a')
    await pump.close()
    expect(pump.closed).toBe(true)
    expect(await web.getReader().read()).toEqual({ done: true, value: undefined })
  })
})

describe('openStreamPump()', () => {
  it('hands back the first chunk without consuming the rest', async () => {
    const { pump, first } = await openStreamPump(iterableOf('one', 'two'))
    expect(Buffer.from(first!).toString()).toBe('one')
    expect(Buffer.from((await pump.next())!).toString()).toBe('two')
    expect(await pump.next()).toBeNull()
  })

  it('reports an empty source as a null first chunk', async () => {
    const { first } = await openStreamPump(iterableOf())
    expect(first).toBeNull()
  })

  it('releases the source and rethrows when it fails before the first byte', async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error('gone'))
      },
    })
    await expect(openStreamPump(source)).rejects.toThrow('gone')
    expect(source.destroyed).toBe(true)
  })
})

describe('nodeStreamFrom()', () => {
  it('replays the peeked chunk and then the rest', async () => {
    const { pump, first } = await openStreamPump(iterableOf('one', 'two'))
    const parts: Buffer[] = []
    for await (const chunk of nodeStreamFrom(pump, first)) parts.push(Buffer.from(chunk as Uint8Array))
    expect(Buffer.concat(parts).toString()).toBe('onetwo')
    expect(pump.closed).toBe(true)
  })

  it('closes the pump — and the source — when the stream is destroyed', async () => {
    const source = Readable.from([bytes('a'), bytes('b'), bytes('c')])
    const { pump, first } = await openStreamPump(source)
    const body = nodeStreamFrom(pump, first)
    body.destroy()
    await new Promise((resolve) => body.on('close', resolve))
    for (let i = 0; i < 20 && !source.destroyed; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(source.destroyed).toBe(true)
    expect(pump.closed).toBe(true)
  })

  it('surfaces a mid-stream failure as an error event', async () => {
    let served = 0
    const source = new Readable({
      read() {
        if (served++ === 0) this.push(bytes('a'))
        else this.destroy(new Error('boom'))
      },
    })
    const { pump, first } = await openStreamPump(source)
    const body = nodeStreamFrom(pump, first)
    await expect(
      (async () => {
        for await (const _chunk of body) void _chunk
      })(),
    ).rejects.toThrow('boom')
  })
})

describe('webStreamFrom()', () => {
  it('replays the peeked chunk, then closes when the source ends', async () => {
    const { pump, first } = await openStreamPump(iterableOf('one', 'two'))
    const reader = webStreamFrom(pump, first).getReader()
    const seen: string[] = []
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      seen.push(Buffer.from(value).toString())
    }
    expect(seen).toEqual(['one', 'two'])
    expect(pump.closed).toBe(true)
  })

  it('errors the body and reports once when the source fails mid-stream', async () => {
    let served = 0
    const source = new Readable({
      read() {
        if (served++ === 0) this.push(bytes('a'))
        else this.destroy(new Error('boom'))
      },
    })
    const { pump, first } = await openStreamPump(source)
    const onError = vi.fn()
    const reader = webStreamFrom(pump, first, onError).getReader()
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('a')
    await expect(reader.read()).rejects.toThrow('boom')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(pump.closed).toBe(true)
  })

  it('closes the pump when the consumer cancels (the client disconnected)', async () => {
    const source = Readable.from([bytes('a'), bytes('b')])
    const { pump, first } = await openStreamPump(source)
    const reader = webStreamFrom(pump, first).getReader()
    await reader.read()
    await reader.cancel()
    expect(pump.closed).toBe(true)
    expect(source.destroyed).toBe(true)
  })
})
