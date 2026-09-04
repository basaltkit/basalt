import { optionLabel, tableView, type Field, type Resource } from '@basaltkit/admin'
import { Badge } from './ui/badge.js'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.js'

export interface DataTableProps {
  resource: Resource
  rows: Record<string, unknown>[]
  onRowClick?: (row: Record<string, unknown>) => void
  emptyLabel?: string
}

/** shadcn-styled table rendering a resource's rows from its Zod-derived view model. */
export function DataTable({ resource, rows, onRowClick, emptyLabel = 'No records' }: DataTableProps) {
  const view = tableView(resource, rows)

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {view.columns.map((column) => (
            <TableHead key={column.name}>{column.label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {view.rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={view.columns.length} className="text-center text-muted-foreground">
              {emptyLabel}
            </TableCell>
          </TableRow>
        ) : (
          view.rows.map((row, index) => (
            <TableRow
              key={String(row[resource.idField] ?? index)}
              {...(onRowClick ? { onClick: () => onRowClick(row), className: 'cursor-pointer' } : {})}
            >
              {view.columns.map((column) => (
                <TableCell key={column.name}>{renderCell(row[column.name], column)}</TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )
}

// Takes the whole field, not just its type, so an enum cell shows the label the
// form shows: a table reading 'person' beside a form reading 'Pessoa' is worse
// than either alone.
function renderCell(value: unknown, field: Field) {
  if (value === undefined || value === null) return ''
  const type = field.type
  if (type === 'enum') return optionLabel(field, String(value))
  if (type === 'boolean') {
    return <Badge variant={value ? 'default' : 'secondary'}>{value ? 'Yes' : 'No'}</Badge>
  }
  if (type === 'date') {
    const date = value instanceof Date ? value : new Date(String(value))
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10)
  }
  return String(value)
}
