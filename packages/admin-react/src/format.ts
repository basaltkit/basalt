import { optionLabel, type Field, type FieldType } from '@basaltkit/admin'

/**
 * Renders a cell value for display, by field type.
 *
 * Passing the whole `Field` rather than its type lets an enum cell show the
 * configured label instead of the stored value — a table reading 'person' next
 * to a form reading 'Pessoa' is worse than either alone. A bare `FieldType`
 * still works and behaves exactly as before.
 */
export function formatCell(value: unknown, field: FieldType | Field): string {
  const type = typeof field === 'string' ? field : field.type
  if (value === undefined || value === null) return ''
  if (type === 'enum' && typeof field !== 'string') return optionLabel(field, String(value))
  if (type === 'boolean') return value ? 'Yes' : 'No'
  if (type === 'date') {
    const date = value instanceof Date ? value : new Date(String(value))
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10)
  }
  return String(value)
}
