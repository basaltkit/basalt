/**
 * Test helper: evaluates the subset of Prisma's `where` the store emits, with
 * SQL's NULL semantics (a comparison against NULL is never true).
 */
export type Where = Record<string, unknown>

export function matches(row: object, where: Where = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w))
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w))
    if (key === 'NOT') return !matches(row, cond as Where)
    const value = (row as unknown as Record<string, unknown>)[key] ?? null
    if (cond === null) return value === null
    if (typeof cond !== 'object' || cond instanceof Date) return value !== null && cmp(value, cond) === 0
    return Object.entries(cond as Record<string, unknown>).every(([op, operand]) => {
      if (op === 'not') return operand === null ? value !== null : value !== null && cmp(value, operand) !== 0
      if (value === null) return false
      const c = cmp(value, operand)
      if (op === 'gte') return c >= 0
      if (op === 'gt') return c > 0
      if (op === 'lte') return c <= 0
      if (op === 'lt') return c < 0
      if (op === 'equals') return c === 0
      throw new Error(`unsupported operator ${op}`)
    })
  })
}
export const cmp = (a: unknown, b: unknown): number => {
  const x = a instanceof Date ? a.getTime() : (a as number | string)
  const y = b instanceof Date ? b.getTime() : (b as number | string)
  return x < y ? -1 : x > y ? 1 : 0
}

