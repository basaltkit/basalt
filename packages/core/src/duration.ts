import { BasaltError } from './errors.js'

/** Number in milliseconds or a human-readable string: '500ms', '30s', '5m', '2h', '7d'. */
export type DurationInput = number | string

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/** Converts a duration to milliseconds. */
export function parseDuration(input: DurationInput): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new BasaltError('DURATION_INVALID', `Invalid duration: ${input}`)
    }
    return input
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(input.trim())
  if (!match) {
    throw new BasaltError(
      'DURATION_INVALID',
      `Invalid duration: "${input}". Use a number in ms or '500ms', '30s', '5m', '2h', '7d'.`,
    )
  }
  return Number(match[1]) * (UNITS[match[2] as string] as number)
}
