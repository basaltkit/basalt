import type { CommitsResult, DetachResult, Release } from '@basaltkit/deploy/protocol'
import type { App } from './app.js'
import { confirmDialog } from './dialog.js'
import { button, card, el, emptyState, pageHead, pill, replace, when, type Child } from './dom.js'
import { icon } from './icons.js'
import type { CommandReply } from './messages.js'
import { problem } from './reply.js'
import { clean, short } from './sanitize.js'
import { commitsBlock, commitSummary, reasonText, unavailable, validCommits } from './view-commits.js'

/** History: the last 10 releases, and rollback (to the last healthy release, or one picked here). */
export function renderHistory(app: App): HTMLElement {
  const status = app.status
  const releases = status?.releases ?? []
  const message = el('div', { aria: { live: 'polite' } })
  const preview = el('div', { class: 'rollback-preview', aria: { live: 'polite' } })
  const current = releases.find((r) => r.status === 'ok')
  const choices = releases.filter((r) => r.status === 'ok' && r !== current)
  const select = el('select', { id: 'rollback-to', on: { change: () => replace(preview) } },
    el('option', { value: '' }, 'the last healthy release (the deploy decides)'),
    ...choices.map((r) => el('option', { value: r.sha }, `${short(r.sha)} — ${when(r.at)}`)))
  return el('section', { aria: { labelledby: 'history-title' } },
    pageHead('history-title', 'History', 'The last 10 releases the server recorded, newest first.',
      el('button', { type: 'button', on: { click: () => { void app.refreshStatus() } } }, icon('refresh'), 'Refresh')),
    !status ? emptyState('history', 'Load the status first.', 'The releases come with the status of the target.') : null,
    releases.length > 0 ? card('Releases', [table(app, releases, status?.subjects)], { bodyClass: 'flush', actions: [el('span', { class: 'muted num' }, `${releases.length} recorded`)] }) : status ? emptyState('inbox', 'No release recorded yet.', 'The first deploy of this target will show here.') : null,
    status ? card('Roll back', [
      el('div', { class: 'field' }, el('label', { for: 'rollback-to' }, 'Back to'), select),
      el('p', { class: 'form-note' }, icon('alert'), 'Code only: the database is not rolled back. The commit it leaves is held: a scheduled run will not redeploy it until the branch moves on.'),
      preview,
      message,
    ], { foot: [
      button('Preview changes', () => { void showPreview(app, select.value, preview) }),
      button('Roll back…', () => { void rollback(app, select.value, message, preview) }, { class: 'danger' }),
    ] }) : null,
  )
}

/** The release each row is compared with: the one it was deployed over, else the next older one on record. */
const previousOf = (releases: Release[], index: number) => releases[index]?.previous || releases[index + 1]?.sha

function table(app: App, releases: Release[], subjects: unknown): HTMLElement {
  const known = typeof subjects === 'object' && subjects !== null ? subjects as Record<string, unknown> : {}
  const columns = ['Commit', 'When', 'Status', 'Actor', 'Via', 'Client', 'Migrations', 'Backup', 'Note']
  return el('div', { class: 'table-wrap' }, el('table', { class: 'releases' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col', class: 'disclosure' }, el('span', { class: 'visually-hidden' }, 'Changes')), ...columns.map((h) => el('th', { scope: 'col' }, h)))),
    el('tbody', {}, ...releases.flatMap((r, index) => {
      const from = previousOf(releases, index)
      const detail = el('td', { colspan: columns.length + 1, class: 'release-changes-cell' })
      const detailRow = el('tr', { class: 'release-changes', hidden: true }, detail)
      const toggle = el('button', {
        type: 'button', class: 'disclosure-button', disabled: !from,
        title: from ? `Commits between ${short(from).slice(0, 7)} and ${short(r.sha).slice(0, 7)}` : 'No earlier release to compare with',
        aria: { expanded: 'false', label: from ? `Show the commits of ${short(r.sha).slice(0, 7)}` : 'No earlier release to compare with' },
        on: { click: () => { void toggleChanges(app, from as string, r.sha, row, detailRow, detail, toggle) } },
      }, icon('chevron'))
      const subject = Object.hasOwn(known, r.sha) ? clean(known[r.sha]) : ''
      const row = el('tr', { class: 'release-row' },
        el('td', { class: 'disclosure' }, toggle),
        el('td', { class: 'release-commit' },
          el('code', {}, short(r.sha).slice(0, 7)),
          subject ? el('span', { class: 'release-subject', title: subject }, subject) : null),
        el('td', { class: 'nowrap num' }, when(r.at)),
        el('td', {}, pill(r.status === 'ok' ? 'ok' : 'err', r.status)),
        el('td', {}, r.actor ?? r.user),
        el('td', { class: 'muted' }, r.via ?? ''),
        el('td', { class: 'mono' }, r.client ?? ''),
        el('td', { class: 'mono wrap' }, r.migrations.join(', ')),
        el('td', { class: 'mono wrap' }, r.backup ?? ''),
        el('td', { class: 'wrap' }, r.note ?? ''),
      )
      return [row, detailRow]
    }))))
}

/** The server's answer to `commits`, as a block: an older deploy that does not know the command is said plainly. */
function commitsReply(reply: CommandReply, labels: Parameters<typeof commitsBlock>[1], order?: Parameters<typeof commitsBlock>[2]): HTMLElement {
  if (reply.error?.code === 'usage' && /unknown command/.test(clean(reply.error.message))) return unavailable('the server\'s @basaltkit/deploy is older than the commit lists')
  if (!reply.ok && !reply.result) return problem(reply) ?? unavailable('no answer')
  const result = reply.result as Partial<CommitsResult> | undefined
  return commitsBlock(result?.commits, labels, order)
}

async function toggleChanges(app: App, from: string, to: string, row: HTMLElement, detailRow: HTMLElement, cell: HTMLElement, toggle: HTMLButtonElement): Promise<void> {
  const open = detailRow.hidden === true
  detailRow.hidden = !open
  row.classList.toggle('is-open', open)
  toggle.setAttribute('aria-expanded', String(open))
  if (!open || cell.dataset['loaded'] === 'yes') return
  replace(cell, el('div', { class: 'commits-note' }, icon('refresh'), el('span', {}, 'Reading the commits on the server…')))
  try {
    const reply = await app.commits(from, to)
    replace(cell, commitsReply(reply, { added: 'Brought in', removed: 'Taken out', same: 'The same commit as the release before: nothing changed.' }))
    if (reply.ok) cell.dataset['loaded'] = 'yes'
  } catch (error) {
    replace(cell, problem(undefined, error))
  }
}

interface Preview {
  /** The commit the deploy would go back to, as the preview resolved it. */
  to?: string
  lines: Child[]
}

/** What `rollback` would take out of production, read now (never from an older status). */
async function readPreview(app: App, to: string): Promise<Preview & { block: HTMLElement }> {
  let reply: CommandReply
  try {
    reply = await app.rollbackPreview(to || undefined)
  } catch (error) {
    return { lines: ['Commit list unavailable: the preview failed — the rollback still works.'], block: problem(undefined, error) ?? unavailable('no answer') }
  }
  const result = reply.result as Partial<CommitsResult> | undefined
  const block = commitsReply(reply, { removed: 'Leaves production', added: 'Comes back (not in the current release)', same: 'Nothing changes.' }, ['removed', 'added'])
  const commits = result?.commits
  if (!validCommits(commits)) return { lines: ['Commit list unavailable — the rollback still works.'], block }
  if (!commits.ok) return { lines: [`Commit list unavailable: ${reasonText(commits.reason)} — the rollback still works.`], block }
  const r = commits.range
  return {
    ...(typeof result?.to === 'string' ? { to: result.to } : {}),
    block,
    lines: [
      r.removedTotal > 0 ? commitSummary('removed', 'Leaves production', r.removed, r.removedTotal) : 'No commit leaves production.',
      r.addedTotal > 0 ? commitSummary('added', 'Comes back (not in the current release)', r.added, r.addedTotal, 4) : null,
    ],
  }
}

async function showPreview(app: App, to: string, area: HTMLElement): Promise<void> {
  replace(area, el('div', { class: 'commits-note' }, icon('refresh'), el('span', {}, 'Reading the commits on the server…')))
  replace(area, (await readPreview(app, to)).block)
}

async function rollback(app: App, to: string, message: HTMLElement, area: HTMLElement): Promise<void> {
  const t = app.current
  if (!t) return
  replace(area, el('div', { class: 'commits-note' }, icon('refresh'), el('span', {}, 'Reading what would leave production…')))
  const preview = await readPreview(app, to)
  replace(area, preview.block)
  const ok = await confirmDialog({
    title: `Roll back ${t.name}?`,
    context: `${t.ssh} · ${t.dir}${app.hello ? ` · host ${app.hello.host}` : ''}`,
    lines: [
      to ? `Back to ${short(to).slice(0, 7)}.` : `Back to the last healthy release${preview.to ? ` — ${short(preview.to).slice(0, 7)} now` : ''}.`,
      ...preview.lines,
      'The commit it leaves is held until the branch moves on.',
    ],
    confirmLabel: 'Roll back',
    danger: true,
    ...(t.protected ? { typeToConfirm: t.name } : {}),
  })
  if (!ok) return
  replace(message, el('p', { class: 'muted' }, 'Starting the rollback…'))
  let reply: CommandReply
  try {
    // Exactly what it sent before the preview existed: the deploy still decides the target when none was picked.
    reply = await app.api.post<CommandReply>('rollback', { target: t.name, confirm: true, confirmedTarget: t, ...(t.protected ? { confirmName: t.name } : {}), ...(to ? { to } : {}) })
  } catch (error) {
    replace(message, problem(undefined, error))
    void app.noticeChange(error)
    return
  }
  const result = reply.result as DetachResult | undefined
  if (reply.ok && result?.runId) {
    replace(message)
    if (preview.to) app.previewedRollbacks.set(result.runId, preview.to)
    app.watch(result.runId, `rollback ${result.runId}`)
    return
  }
  replace(message, problem(reply))
}
