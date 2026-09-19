import { Readable } from 'node:stream'
import type { StreamSource } from './driver.js'
import { StorageTooLargeError } from './errors.js'

const isWebStream = (value: unknown): value is ReadableStream<Uint8Array> =>
  typeof (value as { getReader?: unknown }).getReader === 'function'

/**
 * A web `ReadableStream` as an async iterable whose early exit cancels it.
 * Node ≥ 22 gives `ReadableStream` a `Symbol.asyncIterator`, but not every
 * runtime that hands us one does, so we iterate the reader ourselves.
 */
async function* readWebStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  let finished = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        finished = true
        return
      }
      yield value
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

const toAsyncIterable = (source: StreamSource): AsyncIterable<Uint8Array | string> =>
  isWebStream(source) ? readWebStream(source) : (source as AsyncIterable<Uint8Array | string>)

const asBuffer = (piece: Uint8Array | string): Buffer =>
  typeof piece === 'string' ? Buffer.from(piece) : Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength)

/**
 * Yields the source's bytes, failing with {@link StorageTooLargeError} the
 * moment more than `maxBytes` have gone through.
 *
 * Throwing out of the `for await` returns the iterator, which destroys a Node
 * `Readable` and cancels a web `ReadableStream`: nothing past the limit is ever
 * read from the source, and the upload the generator feeds aborts with it.
 */
async function* limited(source: StreamSource, maxBytes: number | undefined): AsyncGenerator<Buffer> {
  let total = 0
  for await (const piece of toAsyncIterable(source)) {
    const chunk = asBuffer(piece)
    total += chunk.byteLength
    if (maxBytes !== undefined && total > maxBytes) throw new StorageTooLargeError(total, maxBytes)
    yield chunk
  }
}

/**
 * Normalizes any {@link StreamSource} into one Node `Readable` that enforces
 * `maxBytes` as the bytes flow. Every driver receives this — a single shape and
 * a cap none of them can forget to apply.
 */
export function toLimitedReadable(source: StreamSource, maxBytes?: number): Readable {
  return Readable.from(limited(source, maxBytes))
}

/** Collects a stream into one Buffer, capped the same way as {@link toLimitedReadable}. */
export async function collectStream(source: StreamSource, maxBytes?: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of limited(source, maxBytes)) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  return Buffer.concat(chunks, total)
}
