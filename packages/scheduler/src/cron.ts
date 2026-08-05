import { MachizeError } from '@machize/core'

export class CronParseError extends MachizeError {
  constructor(expression: string, detail: string) {
    super('CRON_INVALID', `Expressão cron inválida "${expression}": ${detail}`)
  }
}

export interface CronFields {
  minute: string
  hour: string
  dayOfMonth: string
  month: string
  dayOfWeek: string
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CronParseError(expression, `esperados 5 campos, recebidos ${parts.length}`)
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [
    string,
    string,
    string,
    string,
    string,
  ]
  return { minute, hour, dayOfMonth, month, dayOfWeek }
}

export function cronToString(fields: CronFields): string {
  return [fields.minute, fields.hour, fields.dayOfMonth, fields.month, fields.dayOfWeek].join(' ')
}

/** Suporta: asterisco, passos (asterisco/n), valor único, ranges a-b e listas a,b,c. */
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

/** Decompõe um instante nos campos de cron, no fuso pedido (default UTC). */
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
    // Intl com hour12:false pode emitir 24 para meia-noite
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
