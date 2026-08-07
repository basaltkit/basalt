import { MachizeError } from '@machize/core'
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

export class UnknownExportFormatError extends MachizeError {
  readonly status = 400
  constructor(format: string) {
    super('EXPORT_UNKNOWN_FORMAT', `No formatter registered for "${format}".`)
  }
}

export interface ExportResult {
  content: Buffer
  contentType: string
  filename: string
  format: string
  rowCount: number
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
 * Renders export definitions to files through pluggable formatters. Pure and
 * synchronous to run — for large datasets, call it inside a `@machize/queue`
 * job and store the result with `@machize/files`/`@machize/storage`.
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

  async run<T>(
    definition: ExportDefinition<T>,
    data: Iterable<T> | AsyncIterable<T>,
    format: string,
  ): Promise<ExportResult> {
    const formatter = this.formatters.get(format)
    if (!formatter) throw new UnknownExportFormatError(format)

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
}
