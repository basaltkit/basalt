/**
 * Column-length guard — refuse a value the database would silently truncate.
 *
 * Prisma maps `String` to `TEXT` on PostgreSQL and SQLite, but to
 * `VARCHAR(191)` on MySQL, and a MySQL server outside strict mode truncates an
 * over-long value with only a warning. The row is written, the write reports
 * success, and the value read back is not the value written: a webhook URL
 * that points somewhere else, a file key that no longer names the object, an
 * audit payload whose hash no longer verifies.
 *
 * With `columnLimits` set, the store measures every string it is about to
 * write against the column's capacity and throws `ColumnLengthError` instead.
 * Unset (the default), nothing is checked — PostgreSQL and SQLite store any
 * length and are unaffected.
 *
 * This file is identical in every `@basaltkit/*-prisma` package that has it:
 * the packages stay dependency-free (no runtime dependency beyond their own
 * domain package), so the guard is copied rather than shared.
 */

/**
 * A column's capacity: a number is a maximum in **characters** (MySQL
 * `VARCHAR(n)`); `{ bytes }` is a maximum in **UTF-8 bytes** (MySQL `TEXT`
 * 65 535, `MEDIUMTEXT` 16 777 215 — the `TEXT` family is sized in bytes, and
 * one `utf8mb4` character takes up to four).
 */
export type ColumnLimit = number | { readonly bytes: number }

/** Per-model, per-column capacities. Columns left out are not checked. */
export type ColumnLimits<M extends Record<string, string>> = {
  readonly [K in keyof M]?: Readonly<Partial<Record<M[K], ColumnLimit>>>
}

/** The capacity of `VARCHAR(191)` — what Prisma gives a bare `String` on MySQL. */
export const MYSQL_VARCHAR_DEFAULT = 191
/** `TEXT`: 65 535 bytes. */
export const MYSQL_TEXT: ColumnLimit = { bytes: 65_535 }
/** `MEDIUMTEXT`: 16 777 215 bytes. */
export const MYSQL_MEDIUMTEXT: ColumnLimit = { bytes: 16_777_215 }

/** A value longer than its column holds — refused rather than truncated by the database. */
export class ColumnLengthError extends RangeError {
  readonly code = 'COLUMN_LENGTH_EXCEEDED'
  readonly status = 422
  constructor(
    pkg: string,
    /** `Model.column`. */
    readonly column: string,
    /** The value's measured length, in `unit`. */
    readonly length: number,
    readonly limit: number,
    readonly unit: 'characters' | 'bytes',
  ) {
    // The value itself is never put in the message: it may be PII or a secret.
    super(
      `${pkg}: ${column} is ${length} ${unit}, over its column limit of ${limit}. ` +
        'The write was refused: MySQL outside strict mode would have truncated it silently. ' +
        'Widen the column (see the package schema.mysql.prisma) and raise `columnLimits`, or shorten the value.',
    )
    this.name = 'ColumnLengthError'
  }
}

const isLimit = (value: unknown): value is ColumnLimit =>
  typeof value === 'number'
    ? Number.isSafeInteger(value) && value > 0
    : typeof value === 'object' &&
      value !== null &&
      Number.isSafeInteger((value as { bytes?: unknown }).bytes) &&
      ((value as { bytes: number }).bytes > 0)

/**
 * Resolve the `columnLimits` option: `'mysql'` selects the package preset
 * (matching its `schema.mysql.prisma`), an object is used as given, and
 * `undefined` disables the guard. A malformed limit fails here, at wiring
 * time, not on the first write.
 */
export function resolveColumnLimits<M extends Record<string, string>>(
  pkg: string,
  option: 'mysql' | ColumnLimits<M> | undefined,
  mysql: ColumnLimits<M>,
): ColumnLimits<M> | undefined {
  if (option === undefined) return undefined
  if (option === 'mysql') return mysql
  if (typeof option !== 'object' || option === null) {
    throw new TypeError(`${pkg}: \`columnLimits\` must be 'mysql' or an object of per-model column limits.`)
  }
  for (const [model, columns] of Object.entries(option as Record<string, unknown>)) {
    if (columns === undefined) continue
    if (typeof columns !== 'object' || columns === null) {
      throw new TypeError(`${pkg}: \`columnLimits.${model}\` must be an object of column limits.`)
    }
    for (const [column, limit] of Object.entries(columns as Record<string, unknown>)) {
      if (limit !== undefined && !isLimit(limit)) {
        throw new TypeError(
          `${pkg}: \`columnLimits.${model}.${column}\` must be a positive integer (characters) or { bytes: <positive integer> }.`,
        )
      }
    }
  }
  return option
}

/** Code points, not UTF-16 units: MySQL counts `VARCHAR(n)` in characters. */
function characters(value: string): number {
  // Only strings with surrogate pairs differ; skip the walk for the common case.
  if (!/[\uD800-\uDBFF]/.test(value)) return value.length
  let n = 0
  for (const _ of value) n++
  return n
}

/** The value's length in the limit's unit, or undefined when it fits. */
function overflow(value: string, limit: ColumnLimit): { length: number; max: number; unit: 'characters' | 'bytes' } | undefined {
  if (typeof limit === 'number') {
    // UTF-16 length is an upper bound on the code-point count.
    if (value.length <= limit) return undefined
    const length = characters(value)
    return length > limit ? { length, max: limit, unit: 'characters' } : undefined
  }
  // UTF-8 takes at most 3 bytes per UTF-16 unit.
  if (value.length * 3 <= limit.bytes) return undefined
  const length = Buffer.byteLength(value, 'utf8')
  return length > limit.bytes ? { length, max: limit.bytes, unit: 'bytes' } : undefined
}

/**
 * Throw `ColumnLengthError` when a string in `data` exceeds its column's
 * limit. Non-string values (null, numbers, dates, JSON objects) are skipped.
 */
export function assertColumnLengths(
  pkg: string,
  limits: Readonly<Record<string, Readonly<Record<string, ColumnLimit | undefined>> | undefined>> | undefined,
  model: string,
  data: Readonly<Record<string, unknown>>,
): void {
  const columns = limits?.[model]
  if (!columns) return
  for (const [column, limit] of Object.entries(columns)) {
    const value = data[column]
    if (typeof value !== 'string' || limit === undefined) continue
    const over = overflow(value, limit)
    if (over) throw new ColumnLengthError(pkg, `${model}.${column}`, over.length, over.max, over.unit)
  }
}

/**
 * Shorten a value to fit its column, marking the cut. Only for values that
 * are diagnostic and may be shortened on purpose (an error message) — never
 * for data that must round-trip.
 */
export function clipToColumn(value: string, limit: ColumnLimit | undefined): string {
  if (limit === undefined || overflow(value, limit) === undefined) return value
  const marker = '…[truncated]'
  const budget =
    typeof limit === 'number' ? limit - characters(marker) : limit.bytes - Buffer.byteLength(marker, 'utf8')
  let used = 0
  let out = ''
  for (const char of value) {
    const cost = typeof limit === 'number' ? 1 : Buffer.byteLength(char, 'utf8')
    if (used + cost > budget) break
    used += cost
    out += char
  }
  return out + marker
}
