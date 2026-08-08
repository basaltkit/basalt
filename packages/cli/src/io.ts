import { createInterface } from 'node:readline/promises'
import type { CommandIo } from './command.js'

/** Renders rows as an aligned text table (no external dependencies). */
export function renderTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(empty)'
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  const cell = (value: unknown): string =>
    value === undefined || value === null ? '' : String(value)
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => cell(row[column]).length)),
  )
  const line = (values: string[]) =>
    values.map((value, index) => value.padEnd(widths[index] as number)).join('  ')

  return [
    line(columns),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map((row) => line(columns.map((column) => cell(row[column])))),
  ].join('\n')
}

export function consoleIo(): CommandIo {
  return {
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    table: (rows) => console.log(renderTable(rows)),
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      try {
        const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
        return answer === 'y' || answer === 'yes'
      } finally {
        rl.close()
      }
    },
  }
}

/**
 * In-memory IO for tests. `answers` feeds `confirm()` in order (defaults to yes
 * once the queue is drained), so a test can drive an interactive command.
 */
export function memoryIo(
  options: { answers?: boolean[] } = {},
): CommandIo & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  const answers = [...(options.answers ?? [])]
  return {
    lines,
    errors,
    log: (message) => void lines.push(message),
    error: (message) => void errors.push(message),
    table: (rows) => void lines.push(renderTable(rows)),
    confirm: async () => answers.shift() ?? true,
  }
}
