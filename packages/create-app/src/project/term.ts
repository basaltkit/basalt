/**
 * Output for the project commands: an injectable sink (tests capture it) and
 * ANSI colors that switch off for `NO_COLOR`, `TERM=dumb` and non-TTY output
 * (`FORCE_COLOR` forces them on).
 */

export interface Out {
  /** One line to stdout. */
  log(line?: string): void
  /** One line to stderr. */
  error(line: string): void
}

export interface Colors {
  enabled: boolean
  bold(text: string): string
  dim(text: string): string
  red(text: string): string
  green(text: string): string
  yellow(text: string): string
  cyan(text: string): string
}

export function colorsEnabled(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return false
  const force = env['FORCE_COLOR']
  if (force !== undefined) return force !== '0' && force !== 'false'
  if (env['TERM'] === 'dumb') return false
  return isTTY
}

export function makeColors(enabled: boolean): Colors {
  const wrap = (open: number, close: number) => (text: string) =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text
  return {
    enabled,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  }
}

/** Visible width of a string (ANSI escapes excluded). */
// eslint-disable-next-line no-control-regex
const visible = (text: string): number => text.replace(/\x1b\[\d+m/g, '').length

/** A plain left-aligned table (header row + rows), two spaces between columns. */
export function table(header: readonly string[], rows: readonly (readonly string[])[], colors: Colors): string[] {
  const widths = header.map((cell, i) => Math.max(visible(cell), ...rows.map((row) => visible(row[i] ?? ''))))
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell + ' '.repeat((widths[i] ?? 0) - visible(cell))))
      .join('  ')
      .trimEnd()
  return [colors.dim(line(header)), ...rows.map(line)]
}
