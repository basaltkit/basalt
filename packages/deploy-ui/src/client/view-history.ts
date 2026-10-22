import type { CommitsResult, DetachResult, Release } from '@basaltkit/deploy/protocol'
import type { App } from './app.js'
import { confirmDialog } from './dialog.js'
import { button, card, el, emptyState, pageHead, pill, replace, when, type Child } from './dom.js'
import { t, type MessageKey } from './i18n.js'
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
    el('option', { value: '' }, t('history.lastHealthy')),
    ...choices.map((r) => el('option', { value: r.sha }, `${short(r.sha)} — ${when(r.at)}`)))
  return el('section', { aria: { labelledby: 'history-title' } },
    pageHead('history-title', t('screen.history'), t('history.sub'),
      el('button', { type: 'button', on: { click: () => { void app.refreshStatus() } } }, icon('refresh'), t('refresh'))),
    !status ? emptyState('history', t('history.loadStatus'), t('history.loadStatusText')) : null,
    releases.length > 0 ? card(t('history.releases'), [table(app, releases, status?.subjects)], { bodyClass: 'flush', actions: [el('span', { class: 'muted num' }, t('history.recorded', { count: releases.length }))] }) : status ? emptyState('inbox', t('history.none'), t('history.noneText')) : null,
    status ? card(t('history.rollBack'), [
      el('div', { class: 'field' }, el('label', { for: 'rollback-to' }, t('history.backTo')), select),
      el('p', { class: 'form-note' }, icon('alert'), t('history.codeOnly')),
      preview,
      message,
    ], { foot: [
      button(t('history.preview'), () => { void showPreview(app, select.value, preview) }),
      button(t('history.rollBackEllipsis'), () => { void rollback(app, select.value, message, preview) }, { class: 'danger' }),
    ] }) : null,
  )
}

/** A release's status in the page's language; one this UI does not know is shown as the server wrote it. */
const releaseStatus = (status: string) => (status === 'ok' || status === 'failed' ? t(`release.${status}` as MessageKey) : status)

/** The release each row is compared with: the one it was deployed over, else the next older one on record. */
const previousOf = (releases: Release[], index: number) => releases[index]?.previous || releases[index + 1]?.sha

function table(app: App, releases: Release[], subjects: unknown): HTMLElement {
  const known = typeof subjects === 'object' && subjects !== null ? subjects as Record<string, unknown> : {}
  const columns = (['col.commit', 'col.when', 'col.status', 'col.actor', 'col.via', 'col.client', 'col.migrations', 'col.backup', 'col.note'] as const).map((key) => t(key))
  return el('div', { class: 'table-wrap' }, el('table', { class: 'releases' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col', class: 'disclosure' }, el('span', { class: 'visually-hidden' }, t('history.changes'))), ...columns.map((h) => el('th', { scope: 'col' }, h)))),
    el('tbody', {}, ...releases.flatMap((r, index) => {
      const from = previousOf(releases, index)
      const detail = el('td', { colspan: columns.length + 1, class: 'release-changes-cell' })
      const detailRow = el('tr', { class: 'release-changes', hidden: true }, detail)
      const toggle = el('button', {
        type: 'button', class: 'disclosure-button', disabled: !from,
        title: from ? t('history.between', { from: short(from).slice(0, 7), to: short(r.sha).slice(0, 7) }) : t('history.noEarlier'),
        aria: { expanded: 'false', label: from ? t('history.showCommits', { sha: short(r.sha).slice(0, 7) }) : t('history.noEarlier') },
        on: { click: () => { void toggleChanges(app, from as string, r.sha, row, detailRow, detail, toggle) } },
      }, icon('chevron'))
      const subject = Object.hasOwn(known, r.sha) ? clean(known[r.sha]) : ''
      const row = el('tr', { class: 'release-row' },
        el('td', { class: 'disclosure' }, toggle),
        el('td', { class: 'release-commit' },
          el('code', {}, short(r.sha).slice(0, 7)),
          subject ? el('span', { class: 'release-subject', title: subject }, subject) : null),
        el('td', { class: 'nowrap num' }, when(r.at)),
        el('td', {}, pill(r.status === 'ok' ? 'ok' : 'err', releaseStatus(r.status))),
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
  if (reply.error?.code === 'usage' && /unknown command/.test(clean(reply.error.message))) return unavailable(t('commits.olderDeploy'))
  if (!reply.ok && !reply.result) return problem(reply) ?? unavailable(t('commits.noAnswer'))
  const result = reply.result as Partial<CommitsResult> | undefined
  return commitsBlock(result?.commits, labels, order)
}

async function toggleChanges(app: App, from: string, to: string, row: HTMLElement, detailRow: HTMLElement, cell: HTMLElement, toggle: HTMLButtonElement): Promise<void> {
  const open = detailRow.hidden === true
  detailRow.hidden = !open
  row.classList.toggle('is-open', open)
  toggle.setAttribute('aria-expanded', String(open))
  if (!open || cell.dataset['loaded'] === 'yes') return
  replace(cell, el('div', { class: 'commits-note' }, icon('refresh'), el('span', {}, t('history.reading'))))
  try {
    const reply = await app.commits(from, to)
    replace(cell, commitsReply(reply, { added: t('history.broughtIn'), removed: t('history.takenOut'), same: t('history.same') }))
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
    return { lines: [t('history.previewFailed')], block: problem(undefined, error) ?? unavailable(t('commits.noAnswer')) }
  }
  const result = reply.result as Partial<CommitsResult> | undefined
  const block = commitsReply(reply, { removed: t('history.leaves'), added: t('history.comesBack'), same: t('history.nothingChanges') }, ['removed', 'added'])
  const commits = result?.commits
  if (!validCommits(commits)) return { lines: [t('history.previewUnavailable')], block }
  if (!commits.ok) return { lines: [t('history.previewReason', { reason: reasonText(commits.reason) })], block }
  const r = commits.range
  return {
    ...(typeof result?.to === 'string' ? { to: result.to } : {}),
    block,
    lines: [
      r.removedTotal > 0 ? commitSummary('removed', t('history.leaves'), r.removed, r.removedTotal) : t('history.noneLeaves'),
      r.addedTotal > 0 ? commitSummary('added', t('history.comesBack'), r.added, r.addedTotal, 4) : null,
    ],
  }
}

async function showPreview(app: App, to: string, area: HTMLElement): Promise<void> {
  replace(area, el('div', { class: 'commits-note' }, icon('refresh'), el('span', {}, t('history.reading'))))
  replace(area, (await readPreview(app, to)).block)
}

async function rollback(app: App, to: string, message: HTMLElement, area: HTMLElement): Promise<void> {
  const target = app.current
  if (!target) return
  replace(area, el('div', { class: 'commits-note' }, icon('refresh'), el('span', {}, t('history.readingLeaving'))))
  const preview = await readPreview(app, to)
  replace(area, preview.block)
  const ok = await confirmDialog({
    title: t('history.rollBackTitle', { name: target.name }),
    context: [target.ssh, target.dir, app.hello ? t('ctx.hostPart', { host: app.hello.host }) : null].filter(Boolean).join(' · '),
    lines: [
      to ? t('history.backToSha', { sha: short(to).slice(0, 7) })
      : preview.to ? t('history.backToLastHealthyNow', { sha: short(preview.to).slice(0, 7) })
      : t('history.backToLastHealthy'),
      ...preview.lines,
      t('history.heldUntil'),
    ],
    confirmLabel: t('history.rollBackConfirm'),
    danger: true,
    ...(target.protected ? { typeToConfirm: target.name } : {}),
  })
  if (!ok) return
  replace(message, el('p', { class: 'muted' }, t('history.starting')))
  let reply: CommandReply
  try {
    // Exactly what it sent before the preview existed: the deploy still decides the target when none was picked.
    reply = await app.api.post<CommandReply>('rollback', { target: target.name, confirm: true, confirmedTarget: target, ...(target.protected ? { confirmName: target.name } : {}), ...(to ? { to } : {}) })
  } catch (error) {
    replace(message, problem(undefined, error))
    void app.noticeChange(error)
    return
  }
  const result = reply.result as DetachResult | undefined
  if (reply.ok && result?.runId) {
    replace(message)
    if (preview.to) app.previewedRollbacks.set(result.runId, preview.to)
    app.watch(result.runId, t('run.rollbackTitle', { runId: result.runId }))
    return
  }
  replace(message, problem(reply))
}
