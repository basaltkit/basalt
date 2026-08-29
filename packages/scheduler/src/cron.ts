import { BasaltError } from '@basaltkit/core'

export class CronParseError extends BasaltError {
  constructor(expression: string, detail: string) {
    super('CRON_INVALID', `Invalid cron expression "${expression}": ${detail}`)
  }
}

export interface CronFields {
  minute: string
  hour: string
  dayOfMonth: string
  month: string
  dayOfWeek: string
}

const FIELD_BOUNDS: [name: string, min: number, max: number][] = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day-of-month', 1, 31],
  ['month', 1, 12],
  ['day-of-week', 0, 6],
]

/**
 * Validates one cron field against the syntax {@link fieldMatches} actually
 * supports: asterisk, asterisk-slash-n steps, single values, `a-b` ranges and comma lists.
 * Anything else (names like MON, out-of-range values, `5-1`) previously became
 * NaN comparisons — a job that silently NEVER fires. Fail at parse time instead.
 */
function assertField(expression: string, field: string, name: string, min: number, max: number): void {
  const invalid = (detail: string): never => {
    throw new CronParseError(expression, `${name} field "${field}": ${detail}`)
  }
  if (field === '*') return
  for (const part of field.split(',')) {
    const step = /^\*\/(\d+)$/.exec(part)
    if (step) {
      if (Number(step[1]) < 1) invalid('step must be >= 1')
      continue
    }
    const range = /^(\d+)-(\d+)$/.exec(part)
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])]
      if (from > to) invalid(`range ${from}-${to} is reversed`)
      if (from < min || to > max) invalid(`range ${from}-${to} outside ${min}-${max}`)
      continue
    }
    if (!/^\d+$/.test(part)) invalid(`"${part}" is not supported (use *, */n, n, a-b or comma lists; names like MON are not)`)
    const value = Number(part)
    if (value < min || value > max) invalid(`${value} outside ${min}-${max}`)
  }
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CronParseError(expression, `expected 5 fields, received ${parts.length}`)
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]
  parts.forEach((field, i) => {
    const [name, min, max] = FIELD_BOUNDS[i]!
    assertField(expression, field, name, min, max)
  })
  return { minute, hour, dayOfMonth, month, dayOfWeek }
}

export function cronToString(fields: CronFields): string {
  return [fields.minute, fields.hour, fields.dayOfMonth, fields.month, fields.dayOfWeek].join(' ')
}

/** Supports: asterisk, steps (asterisk/n), single value, a-b ranges and a,b,c lists. */
export function fieldMatches(field: string, value: number): boolean {
  if (field === '*') return true
  return field.split(',').some((part) => {
    const step = /^\*\/(\d+)$/.exec(part)
    if (step) return value % Number(step[1]) === 0
    const range = /^(\d+)-(\d+)$/.exec(part)
    if (range) return value >= Number(range[1]) && value <= Number(range[2])
    return Number(part) === value
  })
}

export interface ZonedParts {
  minute: number
  hour: number
  dayOfMonth: number
  month: number
  dayOfWeek: number
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

/** Decomposes an instant into the cron fields, in the requested time zone (default UTC). */
export function zonedParts(date: Date, timeZone = 'UTC'): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    minute: 'numeric',
    hour: 'numeric',
    day: 'numeric',
    month: 'numeric',
    weekday: 'short',
    hour12: false,
  })
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(date)) {
    parts[part.type] = part.value
  }
  return {
    minute: Number(parts['minute']),
    // Intl with hour12:false may emit 24 for midnight
    hour: Number(parts['hour']) % 24,
    dayOfMonth: Number(parts['day']),
    month: Number(parts['month']),
    dayOfWeek: WEEKDAYS[parts['weekday'] as string] as number,
  }
}

export function cronMatches(fields: CronFields, date: Date, timeZone?: string): boolean {
  const parts = zonedParts(date, timeZone)
  return (
    fieldMatches(fields.minute, parts.minute) &&
    fieldMatches(fields.hour, parts.hour) &&
    fieldMatches(fields.dayOfMonth, parts.dayOfMonth) &&
    fieldMatches(fields.month, parts.month) &&
    fieldMatches(fields.dayOfWeek, parts.dayOfWeek)
  )
}
