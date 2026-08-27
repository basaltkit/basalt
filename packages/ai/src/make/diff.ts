/**
 * A minimal, dependency-free unified-diff generator for the safe-make preview.
 * Line-based LCS with configurable context — enough to show an agent exactly
 * what a write would change (empty `oldText` → an all-additions "new file" diff).
 */

/** Compute the length table of the longest common subsequence of two line arrays. */
function lcsLengths(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  return table
}

type Op = { kind: 'eq' | 'del' | 'add'; line: string }

/** Backtrack the LCS table into an edit script over lines. */
function editScript(a: string[], b: string[]): Op[] {
  const table = lcsLengths(a, b)
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', line: a[i]! })
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: 'del', line: a[i]! })
      i++
    } else {
      ops.push({ kind: 'add', line: b[j]! })
      j++
    }
  }
  while (i < a.length) ops.push({ kind: 'del', line: a[i++]! })
  while (j < b.length) ops.push({ kind: 'add', line: b[j++]! })
  return ops
}

/** Split into lines without a trailing empty element for a final newline. */
function toLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Produce a unified diff of `oldText` → `newText` labelled with `path`.
 * Returns '' when the texts are identical.
 */
export function unifiedDiff(oldText: string, newText: string, path: string, context = 3): string {
  if (oldText === newText) return ''
  const a = toLines(oldText)
  const b = toLines(newText)
  const ops = editScript(a, b)

  // Group ops into hunks separated by runs of >2*context equal lines.
  interface Hunk {
    aStart: number
    bStart: number
    lines: string[]
    aCount: number
    bCount: number
  }
  const hunks: Hunk[] = []
  let aLine = 0
  let bLine = 0
  let current: Hunk | null = null
  let trailingEq = 0

  const flushIfIdle = (): void => {
    if (current && trailingEq > context) {
      // trim the surplus trailing context off the current hunk
      const surplus = trailingEq - context
      current.lines.splice(current.lines.length - surplus)
      current.aCount -= surplus
      current.bCount -= surplus
      hunks.push(current)
      current = null
      trailingEq = 0
    }
  }

  for (const op of ops) {
    if (op.kind === 'eq') {
      if (current) {
        current.lines.push(` ${op.line}`)
        current.aCount++
        current.bCount++
        trailingEq++
        flushIfIdle()
      }
      aLine++
      bLine++
    } else {
      if (!current) {
        const lead = Math.min(context, /* leading context available */ Math.min(aLine, bLine))
        current = { aStart: aLine - lead + 1, bStart: bLine - lead + 1, lines: [], aCount: lead, bCount: lead }
        // pull the leading context lines back in
        const leadLines = a.slice(aLine - lead, aLine).map((l) => ` ${l}`)
        current.lines.push(...leadLines)
      }
      trailingEq = 0
      if (op.kind === 'del') {
        current.lines.push(`-${op.line}`)
        current.aCount++
        aLine++
      } else {
        current.lines.push(`+${op.line}`)
        current.bCount++
        bLine++
      }
    }
  }
  if (current) hunks.push(current)

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`]
  for (const h of hunks) {
    out.push(`@@ -${h.aStart},${h.aCount} +${h.bStart},${h.bCount} @@`)
    out.push(...h.lines)
  }
  return out.join('\n')
}
