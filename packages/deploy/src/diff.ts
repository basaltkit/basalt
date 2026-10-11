/** A line diff (LCS) for audit output: `-` installed, `+` would be written. Small files only (vhosts). */
export function lineDiff(before: string, after: string): string[] {
  const a = before.replace(/\r\n/g, '\n').split('\n')
  const b = after.replace(/\r\n/g, '\n').split('\n')
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[]
      row[j] = a[i] === b[j] ? (lcs[i + 1] as number[])[j + 1] as number + 1 : Math.max((lcs[i + 1] as number[])[j] as number, row[j + 1] as number)
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number)) out.push(`- ${a[i++]}`)
    else out.push(`+ ${b[j++]}`)
  }
  while (i < n) out.push(`- ${a[i++]}`)
  while (j < m) out.push(`+ ${b[j++]}`)
  return out
}
