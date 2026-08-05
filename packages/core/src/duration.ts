import { MachizeError } from './errors.js'

/** Número em milissegundos ou string legível: '500ms', '30s', '5m', '2h', '7d'. */
export type DurationInput = number | string

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** Converte uma duração para milissegundos. */
export function parseDuration(input: DurationInput): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new MachizeError('DURATION_INVALID', `Duração inválida: ${input}`)
    }
    return input
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(input.trim())
  if (!match) {
    throw new MachizeError(
      'DURATION_INVALID',
      `Duração inválida: "${input}". Use um número em ms ou '500ms', '30s', '5m', '2h', '7d'.`,
    )
  }
  return Number(match[1]) * (UNITS[match[2] as string] as number)
}
