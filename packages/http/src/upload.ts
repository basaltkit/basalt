import { Readable } from 'node:stream'
import { z, type ZodType } from 'zod'
import { HttpError } from './errors.js'
import { MultipartParser, malformed, multipartBoundary, sanitizeFilename, type PartHeaders } from './multipart.js'
import type { HttpReply, HttpRequest } from './route.js'

/** Limits for a {@link upload} route body. `maxBytes` and `maxFiles` are required on purpose. */
export interface UploadOptions {
  /** Most bytes the whole request body may carry (multipart framing included). Over it: 413. */
  maxBytes: number
  /** Most file parts accepted. One more: 400 `TOO_MANY_FILES`. */
  maxFiles: number
  /** Most bytes a single file may carry. Default: `maxBytes`. Over it: 413. */
  maxFileBytes?: number
  /** Most non-file fields accepted. Default: 50. One more: 400 `TOO_MANY_FIELDS`. */
  maxFields?: number
  /** Most bytes one field value may carry. Default: 64 KiB. Over it: 413. */
  maxFieldBytes?: number
  /** Most bytes of one part's header block. Default: 8 KiB. Over it: 400. */
  maxHeaderBytes?: number
  /**
   * Accepted declared content types of FILE parts — exact (`image/png`) or a
   * wildcard subtype (`image/*`). Anything else: 415. Default: any. This is
   * the client's claim, not the bytes' — sniff the content before trusting it.
   */
  allowedTypes?: readonly string[]
}

/** One uploaded file, handed to the handler while its bytes are still arriving. */
export interface UploadedFile {
  /** The form field the file was sent under. */
  field: string
  /** Sanitised basename (no directories, controls or bidi tricks) — a label, never a storage key. */
  filename: string
  /** The part's declared `Content-Type` essence (default `application/octet-stream`). Client-controlled. */
  declaredType: string
  /**
   * The file's bytes, streamed. Consume it (or `destroy()` it) before asking
   * for the next file; a file left unread is skipped when the next one is
   * requested. It errors with the limit's HttpError if the upload breaks one.
   */
  stream: Readable
}

/** What an `upload()` route's handler receives as `body`. */
export interface UploadBody {
  /**
   * The file parts, in order, as they arrive — `for await (const file of body.files)`.
   * Nothing is read from the network until this is iterated.
   */
  files: AsyncIterable<UploadedFile>
  /**
   * Non-file fields (null-prototype object; a repeated name keeps its last
   * value). Filled as the body is read: a field sent before a file is present
   * when that file is yielded, and every field once `files` is exhausted.
   */
  fields: Record<string, string>
}

export interface ResolvedUploadOptions {
  maxBytes: number
  maxFiles: number
  maxFileBytes: number
  maxFields: number
  maxFieldBytes: number
  maxHeaderBytes: number
  allowedTypes: readonly string[] | undefined
}

const UPLOADS = new WeakMap<object, ResolvedUploadOptions>()

const positive = (name: string, value: number | undefined, fallback?: number): number => {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < 0 || (name !== 'maxFiles' && resolved < 1)) {
    throw new TypeError(`upload(): \`${name}\` must be a positive integer.`)
  }
  return resolved
}

/**
 * Declares a streaming `multipart/form-data` body for a route — adapter-neutral:
 * the same route accepts uploads on Fastify, Express and Hono.
 *
 * ```ts
 * route({
 *   method: 'POST', url: '/documents',
 *   body: upload({ maxBytes: 20 * 1024 * 1024, maxFiles: 1, allowedTypes: ['application/pdf'] }),
 *   meta: { auth: true },
 *   async handler({ body }) {
 *     for await (const file of body.files) await files().upload({ ..., body: file.stream })
 *   },
 * })
 * ```
 *
 * The whole pipeline — pre-hooks (rate limit), enrichers (tenant, user) and
 * guards (auth, permissions) — runs BEFORE a single body byte is read. The body
 * is then parsed as the handler consumes it, never buffered, with every limit
 * enforced on the bytes actually received (a declared `Content-Length` over
 * `maxBytes` is refused up front). An upload the handler leaves unread is
 * drained (up to `maxBytes`) and the connection closed, so nothing hangs.
 */
export function upload(options: UploadOptions): ZodType<UploadBody> {
  const maxBytes = positive('maxBytes', options.maxBytes)
  const resolved: ResolvedUploadOptions = {
    maxBytes,
    maxFiles: positive('maxFiles', options.maxFiles),
    maxFileBytes: positive('maxFileBytes', options.maxFileBytes, maxBytes),
    maxFields: positive('maxFields', options.maxFields, 50),
    maxFieldBytes: positive('maxFieldBytes', options.maxFieldBytes, 64 * 1024),
    maxHeaderBytes: positive('maxHeaderBytes', options.maxHeaderBytes, 8 * 1024),
    allowedTypes: options.allowedTypes?.map((t) => t.trim().toLowerCase()),
  }
  const schema = z.custom<UploadBody>(
    (value) => typeof value === 'object' && value !== null && 'files' in value && 'fields' in value,
  )
  UPLOADS.set(schema, resolved)
  return schema
}

/** The resolved limits when `schema` came from {@link upload}; otherwise `undefined`. */
export function uploadOptionsOf(schema: unknown): ResolvedUploadOptions | undefined {
  return typeof schema === 'object' && schema !== null ? UPLOADS.get(schema) : undefined
}

/** True when a route's `body` is an {@link upload} declaration — adapters skip their own body parsing for it. */
export const isUploadBody = (schema: unknown): boolean => uploadOptionsOf(schema) !== undefined

const typeAllowed = (allowed: readonly string[] | undefined, type: string): boolean => {
  if (!allowed) return true
  return allowed.some((entry) =>
    entry.endsWith('/*') ? type.startsWith(entry.slice(0, -1)) : entry === type,
  )
}

/** A pull interface over a Node Readable or a web ReadableStream. */
interface ByteSource {
  read(): Promise<Uint8Array | null>
  /** Stops reading without destroying the transport (so a response can still be written). */
  stop(): void
}

const closedEarly = (): HttpError => malformed('Upload stream ended unexpectedly.')

function nodeSource(stream: Readable): ByteSource {
  let ended = stream.readableEnded
  let failure: unknown
  let wake: (() => void) | undefined
  const notify = () => {
    const resolve = wake
    wake = undefined
    resolve?.()
  }
  const onEnd = () => {
    ended = true
    notify()
  }
  const onError = (error: unknown) => {
    failure ??= error
    notify()
  }
  const onClose = () => {
    if (!ended && !stream.readableEnded) failure ??= closedEarly()
    notify()
  }
  const onAborted = () => {
    failure ??= closedEarly()
    notify()
  }
  // A permanent no-op listener: an aborted client must never surface as an
  // unhandled 'error' event after this source stopped listening.
  stream.on('error', () => {})
  stream.on('readable', notify)
  stream.on('end', onEnd)
  stream.on('error', onError)
  stream.on('close', onClose)
  stream.on('aborted', onAborted)
  return {
    async read() {
      for (;;) {
        if (failure !== undefined) throw failure
        const chunk: unknown = stream.read()
        if (chunk !== null) return typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Uint8Array)
        if (ended || stream.readableEnded) return null
        if (stream.destroyed) throw closedEarly()
        await new Promise<void>((resolve) => (wake = resolve))
      }
    },
    stop() {
      stream.off('readable', notify)
      stream.off('end', onEnd)
      stream.off('error', onError)
      stream.off('close', onClose)
      stream.off('aborted', onAborted)
      notify()
    },
  }
}

function webSource(stream: ReadableStream<Uint8Array>): ByteSource {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  return {
    async read() {
      try {
        reader ??= stream.getReader()
        const { done, value } = await reader.read()
        return done ? null : value
      } catch {
        throw closedEarly()
      }
    },
    stop() {
      try {
        reader?.releaseLock()
      } catch {
        /* a read is still pending — the runtime reclaims the body with the request */
      }
    },
  }
}

function toSource(input: unknown): ByteSource | undefined {
  if (input instanceof Readable || (typeof input === 'object' && input !== null && typeof (input as Readable).read === 'function' && typeof (input as Readable).on === 'function')) {
    return nodeSource(input as Readable)
  }
  if (typeof ReadableStream !== 'undefined' && input instanceof ReadableStream) return webSource(input)
  return undefined
}

class FileStream extends Readable {
  constructor(private readonly demand: () => void) {
    super()
    // Errors are delivered to whoever consumes the stream; one nobody consumes
    // (skipped, or abandoned by the handler) must not crash the process.
    this.on('error', () => {})
  }
  override _read(): void {
    this.demand()
  }
}

type Current =
  | { kind: 'file'; file: UploadedFile & { stream: FileStream }; bytes: number }
  | { kind: 'field'; name: string; chunks: Buffer[]; bytes: number }
  | { kind: 'skip' }

/**
 * One request's upload: validates the request framing, then pulls bytes from
 * the transport only as the handler consumes files (or when the route is done
 * and the rest must be drained). Created by the pipeline; not public API.
 */
export class UploadSession {
  private readonly fields: Record<string, string> = Object.create(null) as Record<string, string>
  private source: ByteSource | undefined
  private parser: MultipartParser | undefined
  private received = 0
  private fileCount = 0
  private fieldCount = 0
  private current: Current | undefined
  private readonly queue: UploadedFile[] = []
  private lastYielded: UploadedFile | undefined
  private finished = false
  private failure: unknown
  private waiter: (() => void) | undefined
  private running = false
  private demand = false
  private discarding = false

  constructor(
    private readonly request: HttpRequest,
    readonly options: ResolvedUploadOptions,
  ) {}

  /** Validates the request framing (415/400/413) and returns the handler's `body`. */
  open(): UploadBody {
    const raw = this.request.headers['content-type']
    const boundary = multipartBoundary(Array.isArray(raw) ? raw[0] : raw)
    const length = this.declaredLength()
    if (length !== undefined && length > this.options.maxBytes) throw tooLarge()
    const source = toSource(this.request.bodyStream)
    if (!source) throw malformed('Upload body is not available.')
    this.source = source
    this.parser = new MultipartParser(
      boundary,
      {
        onPartStart: (part) => this.partStart(part),
        onPartData: (chunk) => this.partData(chunk),
        onPartEnd: () => this.partEnd(),
      },
      this.options.maxHeaderBytes,
    )
    const iterator: AsyncIterator<UploadedFile> = {
      next: () => this.next(),
      return: async () => {
        this.abandonLast()
        return { done: true, value: undefined }
      },
    }
    return { files: { [Symbol.asyncIterator]: () => iterator }, fields: this.fields }
  }

  /**
   * Called once the route is done (handler returned or threw, or a guard
   * rejected). An upload not read to the end gets `Connection: close` and is
   * drained in the background up to `maxBytes`, then left for the server to
   * close — the request can never hang on an unread body.
   */
  release(reply: HttpReply): void {
    if (this.finished) return
    if (!reply.sent) {
      try {
        reply.header('connection', 'close')
      } catch {
        /* headers already flushed */
      }
    }
    if (this.failure !== undefined) return
    if (!this.source) {
      // Never opened (a guard or the framing check rejected it): drain raw.
      const length = this.declaredLength()
      if (length !== undefined && length > this.options.maxBytes) return
      const source = toSource(this.request.bodyStream)
      if (source) void drainRaw(source, this.options.maxBytes)
      return
    }
    this.discarding = true
    for (const file of this.queue.splice(0)) skip(file)
    if (this.lastYielded) skip(this.lastYielded)
    this.kick()
  }

  private declaredLength(): number | undefined {
    const raw = this.request.headers['content-length']
    const value = Array.isArray(raw) ? raw[0] : raw
    return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined
  }

  private async next(): Promise<IteratorResult<UploadedFile>> {
    this.abandonLast()
    for (;;) {
      if (this.failure !== undefined) throw this.failure
      const file = this.queue.shift()
      if (file) {
        this.lastYielded = file
        return { done: false, value: file }
      }
      if (this.finished) return { done: true, value: undefined }
      await new Promise<void>((resolve) => {
        this.waiter = resolve
        this.kick()
      })
    }
  }

  /** The previous file, if nobody is reading it, is skipped so the parser can move on. */
  private abandonLast(): void {
    const last = this.lastYielded
    if (last && !last.stream.readableEnded && last.stream.readableFlowing !== true) skip(last)
  }

  private wantMore(): boolean {
    if (this.failure !== undefined || this.finished) return false
    if (this.discarding) return true
    const current = this.current
    if (current?.kind === 'file' && !current.file.stream.destroyed) {
      // Only pull while the file's reader has room, so a slow consumer
      // backpressures the network instead of filling memory.
      return this.demand
    }
    return this.waiter !== undefined && this.queue.length === 0
  }

  private kick(): void {
    if (this.running) return
    this.running = true
    void (async () => {
      try {
        while (this.wantMore()) await this.pump()
      } catch (error) {
        this.fail(error)
      } finally {
        this.running = false
      }
    })()
  }

  private async pump(): Promise<void> {
    const chunk = await this.source!.read()
    if (chunk === null) {
      this.parser!.end()
      this.finished = true
      this.source!.stop()
      this.wake()
      return
    }
    this.received += chunk.byteLength
    if (this.received > this.options.maxBytes) throw tooLarge()
    this.parser!.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
    this.wake()
  }

  private wake(): void {
    if (this.waiter && (this.queue.length > 0 || this.finished || this.failure !== undefined)) {
      const resolve = this.waiter
      this.waiter = undefined
      resolve()
    }
  }

  private fail(error: unknown): void {
    this.failure = error instanceof HttpError ? error : closedEarly()
    const current = this.current
    if (current?.kind === 'file' && !current.file.stream.readableEnded) current.file.stream.destroy(this.failure as Error)
    for (const file of this.queue.splice(0)) file.stream.destroy(this.failure as Error)
    this.current = undefined
    this.source?.stop()
    const resolve = this.waiter
    this.waiter = undefined
    resolve?.()
  }

  private partStart(part: PartHeaders): void {
    if (part.filename === undefined) {
      if (++this.fieldCount > this.options.maxFields) {
        throw new HttpError(400, 'TOO_MANY_FIELDS', 'Too many form fields.')
      }
      this.current = { kind: 'field', name: part.name, chunks: [], bytes: 0 }
      return
    }
    // A browser sends an empty, nameless file part for a file input left blank.
    if (part.filename === '') {
      this.current = { kind: 'skip' }
      return
    }
    if (++this.fileCount > this.options.maxFiles) {
      throw new HttpError(400, 'TOO_MANY_FILES', 'Too many files.')
    }
    const declaredType = part.contentType ?? 'application/octet-stream'
    if (declaredType.startsWith('multipart/')) throw malformed('Nested multipart bodies are not supported.')
    if (!typeAllowed(this.options.allowedTypes, declaredType)) {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'File type is not allowed.')
    }
    const stream = new FileStream(() => {
      this.demand = true
      this.kick()
    })
    this.demand = false
    const file = { field: part.name, filename: sanitizeFilename(part.filename), declaredType, stream }
    this.current = { kind: 'file', file, bytes: 0 }
    this.queue.push(file)
    if (this.discarding) skip(file)
  }

  private partData(chunk: Buffer): void {
    const current = this.current
    if (!current || current.kind === 'skip') return
    current.bytes += chunk.length
    if (current.kind === 'field') {
      if (current.bytes > this.options.maxFieldBytes) throw tooLarge()
      current.chunks.push(chunk)
      return
    }
    if (current.bytes > this.options.maxFileBytes) throw tooLarge()
    const { stream } = current.file
    // A destroyed stream (the handler gave up on it) just discards its bytes.
    if (!stream.destroyed && !stream.push(chunk)) this.demand = false
  }

  private partEnd(): void {
    const current = this.current
    this.current = undefined
    if (current?.kind === 'field') {
      this.fields[current.name] = Buffer.concat(current.chunks).toString('utf8')
    } else if (current?.kind === 'file' && !current.file.stream.destroyed) {
      current.file.stream.push(null)
    }
  }
}

const tooLarge = (): HttpError => new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Upload is too large.')

/** Discards a file nobody will read: flowing with no listener drops its bytes. */
function skip(file: UploadedFile): void {
  if (!file.stream.destroyed && file.stream.readableFlowing !== true) file.stream.resume()
}

async function drainRaw(source: ByteSource, cap: number): Promise<void> {
  let received = 0
  try {
    for (;;) {
      const chunk = await source.read()
      if (chunk === null) break
      received += chunk.byteLength
      if (received > cap) break
    }
  } catch {
    /* the client went away — nothing left to drain */
  } finally {
    source.stop()
  }
}
