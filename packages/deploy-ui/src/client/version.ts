import type { Source } from '@basaltkit/deploy/protocol'
import { el, type Child } from './dom.js'
import { t, type MessageKey } from './i18n.js'
import { banner } from './reply.js'
import { clean } from './sanitize.js'

/**
 * What this page uses from the server's @basaltkit/deploy, and from which
 * version. A server behind is said plainly — what is missing, and the
 * update — so an "unavailable" never has to be guessed at. The page imports
 * no code from the deploy package: the versions are listed here.
 */
export const FEATURES: ReadonlyArray<{ since: string; key: MessageKey }> = [
  { since: '0.8.0', key: 'feature.commits' },
  { since: '0.9.0', key: 'feature.source' },
]

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-[0-9A-Za-z.-]{1,64})?$/

/** `x.y.z` compared numerically; a pre-release counts as before its release. Undefined when either is not a version. */
export function compareVersions(a: string, b: string): number | undefined {
  const x = VERSION.exec(a)
  const y = VERSION.exec(b)
  if (!x || !y) return undefined
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d !== 0) return Math.sign(d)
  }
  const pre = (v: string) => v.includes('-')
  return pre(a) === pre(b) ? 0 : pre(a) ? -1 : 1
}

/** The features a server's version lacks, and the version that has them all; undefined when it is current (or not a version). */
export function behind(version: unknown): { needed: string; missing: Array<{ since: string; key: MessageKey }> } | undefined {
  if (typeof version !== 'string') return undefined
  const missing = FEATURES.filter((f) => compareVersions(version, f.since) === -1)
  if (missing.length === 0) return undefined
  const needed = missing.reduce((top, f) => (compareVersions(f.since, top) === 1 ? f.since : top), missing[0]?.since as string)
  return { needed, missing }
}

/** The notice: what is missing, and how to update — the second deploy included. Null when the server is current. */
export function driftBanner(version: unknown): HTMLElement | null {
  const gap = behind(version)
  if (!gap) return null
  const current = clean(version)
  const command = `pnpm add -D @basaltkit/deploy@^${gap.needed}`
  const lines: Child[] = [
    t('drift.missing', { list: gap.missing.map((f) => t(f.key, { since: f.since })).join(', ') }),
    el('span', {}, t('drift.how'), ' ', el('code', {}, command), t('drift.howTail')),
    t('drift.twice', { version: current, needed: gap.needed }),
  ]
  const node = banner('warn', t('drift.title', { version: current, needed: gap.needed }), lines)
  node.classList.add('drift')
  return node
}

/** A source from the server, checked: anything else is no source (an older deploy sends none). */
export function validSource(value: unknown): Source | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const s = value as Record<string, unknown>
  if (typeof s['remote'] !== 'string' || typeof s['branch'] !== 'string') return undefined
  if (s['url'] !== undefined && typeof s['url'] !== 'string') return undefined
  return { remote: clean(s['remote']), branch: clean(s['branch']), ...(typeof s['url'] === 'string' ? { url: clean(s['url']) } : {}) }
}

/** `github.com/acme/app (main)`, or `origin/main` when the address is not known. */
export function sourceText(source: Source): string {
  return source.url ? `${source.url} (${source.branch})` : `${source.remote}/${source.branch}`
}
