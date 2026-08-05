import { tableView, type Resource } from '@machize/admin'
import { formatCell } from './format.js'

export interface DataTableProps {
  resource: Resource
  rows: Record<string, unknown>[]
  onRowClick?: (row: Record<string, unknown>) => void
  emptyLabel?: string
}

/** Renders a resource's rows as a table, columns and cell formatting derived from the schema. */
export function DataTable({ resource, rows, onRowClick, emptyLabel = 'No records' }: DataTableProps) {
  const view = tableView(resource, rows)

  return (
    <table>
      <thead>
        <tr>
          {view.columns.map((column) => (
            <th key={column.name}>{column.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {view.rows.length === 0 ? (
          <tr>
            <td colSpan={view.columns.length}>{emptyLabel}</td>
          </tr>
        ) : (
          view.rows.map((row, index) => (
            <tr
              key={String(row[resource.idField] ?? index)}
              {...(onRowClick ? { onClick: () => onRowClick(row) } : {})}
            >
              {view.columns.map((column) => (
                <td key={column.name}>{formatCell(row[column.name], column.type)}</td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  )
}
