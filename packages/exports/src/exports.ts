import { BasaltError } from '@basaltkit/core'
import { nativeFormatters, type ExportFormatter } from './formatters.js'

/** One output column: a header and how to read the cell from a row. */
export interface ExportColumn<T> {
  header: string
  value: (row: T) => unknown
}

/** A named export shape — the columns to emit for a row type `T`. */
export interface ExportDefinition<T> {
  name: string
  columns: ExportColumn<T>[]
}

export function defineExport<T>(definition: ExportDefinition<T>): ExportDefinition<T> {
  return definition
}

export class UnknownExportFormatError extends BasaltError {
  readonly status = 400
  constructor(format: string) {
    super('EXPORT_UNKNOWN_FORMAT', `No formatter registered for "${format}".`)
  }
}

export class ExportNotStreamableError extends BasaltError {
  readonly status = 400
  constructor(format: string) {
    super(
      'EXPORT_NOT_STREAMABLE',
      `The "${format}" formatter cannot stream (it has no renderStream) — use run(), which buffers the whole file.`,
    )
  }
}

export interface ExportResult {
  content: Buffer
  contentType: string
  filename: string
  format: string
  rowCount: number
}

/**
 * A streamed export: an `AsyncIterable<Buffer>` of file chunks plus the
 * metadata a response needs up front. Single-use — iterate it once (or hand it
 * to `Readable.from()` / a `Response` body). `rowCount` counts rows rendered so
 * far and is final once iteration completes.
 */
export interface ExportStream extends AsyncIterable<Buffer> {
  readonly contentType: string
  readonly filename: string
  readonly format: string
  readonly rowCount: number
}

export interface ExportStreamOptions {
  /** Flush a chunk once this many bytes are pending. Default 64 KiB. */
  chunkSize?: number
}

const DEFAULT_CHUNK_SIZE = 64 * 1024

async function* toAsync<T>(data: Iterable<T> | AsyncIterable<T>): AsyncGenerator<T> {
  yield* data as AsyncIterable<T>
}

async function collect<T>(data: Iterable<T> | AsyncIterable<T>): Promise<T[]> {
  if (Array.isArray(data)) return data
  if (Symbol.asyncIterator in (data as AsyncIterable<T>)) {
    const rows: T[] = []
    for await (const row of data as AsyncIterable<T>) rows.push(row)
    return rows
  }
  return [...(data as Iterable<T>)]
}

/**
 * Renders export definitions to files through pluggable formatters. `run()`
 * builds the whole file in memory; `stream()` emits it in chunks for formats
 * that can stream (csv/tsv/json/ndjson). For large datasets, call either inside
 * a `@basaltkit/queue` job and store the result with `@basaltkit/files`/`@basaltkit/storage`.
 */
export class Exports {
  private readonly formatters = new Map<string, ExportFormatter>()

  constructor(options: { formatters?: ExportFormatter[] } = {}) {
    for (const formatter of [...nativeFormatters, ...(options.formatters ?? [])]) this.register(formatter)
  }

  register(formatter: ExportFormatter): this {
    this.formatters.set(formatter.format, formatter)
    return this
  }

  formats(): string[] {
    return [...this.formatters.keys()]
  }

  /** Formats that `stream()` accepts — those whose formatter implements `renderStream`. */
  streamableFormats(): string[] {
    return [...this.formatters.values()].filter((f) => typeof f.renderStream === 'function').map((f) => f.format)
  }

  async run<T>(
    definition: ExportDefinition<T>,
    data: Iterable<T> | AsyncIterable<T>,
    format: string,
  ): Promise<ExportResult> {
    const formatter = this.formatters.get(format)
    if (!formatter) throw new UnknownExportFormatError(format)

    // Buffered by design: the result is one Buffer. For large datasets in a
    // streamable format (csv/tsv/json/ndjson), use stream() instead.
    const rows = await collect(data)
    const headers = definition.columns.map((c) => c.header)
    const cells = rows.map((row) => definition.columns.map((c) => c.value(row)))
    const content = await formatter.render(headers, cells)

    return {
      content,
      contentType: formatter.contentType,
      filename: `${definition.name}.${formatter.extension}`,
      format,
      rowCount: rows.length,
    }
  }

  /**
   * Renders incrementally: rows are pulled from `data` one at a time and the
   * file is emitted in chunks of about `chunkSize` bytes, so memory stays
   * bounded however large the dataset. Only for formats whose formatter
   * implements `renderStream` (the native csv/tsv/json/ndjson); throws
   * `ExportNotStreamableError` for buffer-only ones such as xlsx/pdf. The
   * streamed bytes are identical to `run()`'s `content`.
   */
  stream<T>(
    definition: ExportDefinition<T>,
    data: Iterable<T> | AsyncIterable<T>,
    format: string,
    options: ExportStreamOptions = {},
  ): ExportStream {
    const formatter = this.formatters.get(format)
    if (!formatter) throw new UnknownExportFormatError(format)
    const renderStream = formatter.renderStream?.bind(formatter)
    if (!renderStream) throw new ExportNotStreamableError(format)

    const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE)
    const headers = definition.columns.map((c) => c.header)
    let rowCount = 0

    async function* cells(): AsyncGenerator<unknown[]> {
      for await (const row of toAsync(data)) {
        rowCount++
        yield definition.columns.map((c) => c.value(row))
      }
    }

    async function* chunks(): AsyncGenerator<Buffer> {
      let pending: Buffer[] = []
      let size = 0
      for await (const piece of renderStream!(headers, cells())) {
        const buf = typeof piece === 'string' ? Buffer.from(piece) : piece
        pending.push(buf)
        size += buf.length
        if (size >= chunkSize) {
          yield Buffer.concat(pending, size)
          pending = []
          size = 0
        }
      }
      if (size > 0) yield Buffer.concat(pending, size)
    }

    let started = false
    return {
      contentType: formatter.contentType,
      filename: `${definition.name}.${formatter.extension}`,
      format,
      get rowCount() {
        return rowCount
      },
      [Symbol.asyncIterator]() {
        if (started) throw new Error('An ExportStream can only be iterated once.')
        started = true
        return chunks()
      },
    }
  }
}
