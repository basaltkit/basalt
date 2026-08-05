import type { FieldType } from '@machize/admin'

/** Renders a cell value for display, by field type. */
export function formatCell(value: unknown, type: FieldType): string {
  if (value === undefined || value === null) return ''
  if (type === 'boolean') return value ? 'Yes' : 'No'
  if (type === 'date') {
    const date = value instanceof Date ? value : new Date(String(value))
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10)
  }
  return String(value)
}
