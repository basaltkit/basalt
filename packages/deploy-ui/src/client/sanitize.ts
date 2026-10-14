/**
 * Every string from the server is data (RFC 0009 §9). The deploy already
 * sanitised it; the page does it again before it reaches a text node: ANSI/VT
 * sequences, C0/C1 controls but tab and newline, and bidi controls (a
 * "Trojan Source" line must not reorder what the operator reads).
 */
export function clean(value: unknown): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]?/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, '')
}

/** A commit as the UI shows it. */
export const short = (sha: unknown) => clean(sha).slice(0, 12)
