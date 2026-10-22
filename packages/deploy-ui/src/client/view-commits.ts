import type { CommitInfo, CommitRange, Commits, CommitsUnavailable } from '@basaltkit/deploy/protocol'
import { el, type Child } from './dom.js'
import { icon } from './icons.js'
import { clean, short } from './sanitize.js'

/**
 * The commit lists (RFC 0009 §7): what a run would deploy, what a release
 * changed, what a rollback would take out. Every field is the author's text
 * — rendered as text nodes only, cleaned again here, never a link. A list
 * that is missing or unavailable is said so and never disables an action.
 */

/** Fixed local text for each reason: the server's wording never reaches the page. */
const REASONS: Record<CommitsUnavailable, string> = {
  'skipped': 'the fetch is skipped, so a run deploys the commit already checked out',
  'not-fetched': 'the server could not fetch the branch from its remote',
  'no-previous': 'there is no earlier release to compare with',
  'missing-commit': 'a commit is not in the server\'s checkout (rewritten history, or never fetched there)',
  'shallow': 'the server\'s checkout is a shallow clone, so its history is incomplete',
  'unrelated': 'the two commits share no history',
  'timeout': 'git took too long on the server',
  'too-large': 'git\'s answer was too large',
  'malformed': 'git\'s answer could not be read',
  'git-failed': 'git failed on the server',
}

export function reasonText(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(REASONS, reason) ? REASONS[reason as CommitsUnavailable] : 'the server gave no usable reason'
}

/** A shape check: anything from the server that is not a list of commits is "unavailable", never a crash. */
export function validCommits(value: unknown): value is Commits {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  if (c['ok'] === false) return true
  const r = c['range'] as Record<string, unknown> | undefined
  return c['ok'] === true && typeof r === 'object' && r !== null && Array.isArray(r['added']) && Array.isArray(r['removed'])
    && typeof r['addedTotal'] === 'number' && typeof r['removedTotal'] === 'number' && typeof r['from'] === 'string' && typeof r['to'] === 'string'
}

/** Why there is no list: a quiet note, never an error the operator must clear. */
export function unavailable(text: string): HTMLElement {
  return el('div', { class: 'commits-note' }, icon('info'), el('span', {}, el('strong', {}, 'Commit list unavailable'), ` — ${text}.`))
}

/** `1 Oct 2026, 10:00` in the operator's locale; the exact time in the tooltip. */
function date(at: string | undefined): HTMLElement | null {
  if (typeof at !== 'string') return null
  const parsed = new Date(at)
  if (Number.isNaN(parsed.getTime())) return null
  return el('time', { title: clean(at) }, parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))
}

function commitItem(c: CommitInfo): HTMLElement {
  const subject = clean(c.subject)
  const author = clean(c.author)
  return el('li', { class: c.merge ? 'commit is-merge' : 'commit' },
    el('span', { class: 'commit-dot', aria: { hidden: 'true' } }),
    el('code', { class: 'commit-sha', title: short(c.sha) }, short(c.sha).slice(0, 7)),
    el('span', { class: 'commit-subject', title: subject }, c.merge ? icon('merge', 'icon commit-merge') : null, subject || el('span', { class: 'muted' }, '(no subject)')),
    el('span', { class: 'commit-meta' }, author ? el('span', { class: 'commit-author' }, author) : null, date(c.at)))
}

export type Tone = 'added' | 'removed'

/** The most commits the server sends per list (COMMITS_LIMIT): the page imports no code from the deploy package. */
const LIST_LIMIT = 50

/** One side of a range: a heading with its sign and count, the commits newest first, and what the cap left out. */
export function commitGroup(tone: Tone, label: string, list: CommitInfo[], total: number): HTMLElement {
  return el('section', { class: `commit-group commit-group-${tone}`, aria: { label: `${label}: ${total}` } },
    el('header', { class: 'commit-group-head' },
      el('span', { class: 'commit-sign', aria: { hidden: 'true' } }, tone === 'added' ? '+' : '−'),
      el('span', { class: 'commit-group-title' }, label),
      el('span', { class: 'commit-count' }, String(total))),
    el('ol', { class: 'commit-list' }, ...list.map(commitItem)),
    total > list.length ? el('p', { class: 'commit-more' }, `+ ${total - list.length} older commit${total - list.length === 1 ? '' : 's'} not shown — the server sends at most ${LIST_LIMIT} per list.`) : null)
}

export interface CommitLabels {
  /** The `to ^from` list. */
  added: string
  /** The `from ^to` list. */
  removed: string
  /** Nothing changes. */
  same: string
}

/** `abc1234 → def5678`, for a card's head. */
export function rangeSpan(range: Pick<CommitRange, 'from' | 'to'>): HTMLElement {
  return el('span', { class: 'commit-span' }, el('code', {}, short(range.from).slice(0, 7)), icon('arrow'), el('code', {}, short(range.to).slice(0, 7)))
}

/**
 * Both sides of a range, under their labels, or why there are none. An
 * absent field (an older deploy on the server) is said plainly too.
 */
export function commitsBlock(value: unknown, labels: CommitLabels, order: Tone[] = ['added', 'removed']): HTMLElement {
  if (value === undefined) return unavailable('the server\'s @basaltkit/deploy is older than the commit lists')
  if (!validCommits(value)) return unavailable('the server\'s answer could not be read')
  if (!value.ok) return unavailable(reasonText(value.reason))
  const r = value.range
  if (r.addedTotal === 0 && r.removedTotal === 0) return el('div', { class: 'commits-note is-ok' }, icon('ok'), el('span', {}, labels.same))
  const groups: Record<Tone, Child> = {
    added: r.addedTotal > 0 ? commitGroup('added', labels.added, r.added, r.addedTotal) : null,
    removed: r.removedTotal > 0 ? commitGroup('removed', labels.removed, r.removed, r.removedTotal) : null,
  }
  return el('div', { class: 'commits' }, ...order.map((tone) => groups[tone]))
}

/** A compact list for a confirmation dialog: at most `max` commits, then how many more. */
export function commitSummary(tone: Tone, label: string, list: CommitInfo[], total: number, max = 8): HTMLElement {
  const shown = list.slice(0, max)
  return el('span', { class: `commit-summary commit-group-${tone}` },
    el('span', { class: 'commit-summary-head' }, el('span', { class: 'commit-sign', aria: { hidden: 'true' } }, tone === 'added' ? '+' : '−'), `${label} `, el('span', { class: 'commit-count' }, String(total))),
    ...shown.map((c) => el('span', { class: 'commit-summary-row' }, el('code', { class: 'commit-sha' }, short(c.sha).slice(0, 7)), el('span', { class: 'commit-subject' }, clean(c.subject)))),
    total > shown.length ? el('span', { class: 'commit-more' }, `and ${total - shown.length} more`) : null)
}
