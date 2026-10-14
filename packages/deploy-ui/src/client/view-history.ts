import type { DetachResult, Release } from '@basaltkit/deploy/protocol'
import type { App } from './app.js'
import { confirmDialog } from './dialog.js'
import { button, card, el, emptyState, pageHead, pill, replace, when } from './dom.js'
import { icon } from './icons.js'
import type { CommandReply } from './messages.js'
import { problem } from './reply.js'
import { short } from './sanitize.js'

/** History: the last 10 releases, and rollback (to the last healthy release, or one picked here). */
export function renderHistory(app: App): HTMLElement {
  const status = app.status
  const releases = status?.releases ?? []
  const message = el('div', { aria: { live: 'polite' } })
  const current = releases.find((r) => r.status === 'ok')
  const choices = releases.filter((r) => r.status === 'ok' && r !== current)
  const select = el('select', { id: 'rollback-to' },
    el('option', { value: '' }, 'the last healthy release (the deploy decides)'),
    ...choices.map((r) => el('option', { value: r.sha }, `${short(r.sha)} — ${when(r.at)}`)))
  return el('section', { aria: { labelledby: 'history-title' } },
    pageHead('history-title', 'History', 'The last 10 releases the server recorded, newest first.',
      el('button', { type: 'button', on: { click: () => { void app.refreshStatus() } } }, icon('refresh'), 'Refresh')),
    !status ? emptyState('history', 'Load the status first.', 'The releases come with the status of the target.') : null,
    releases.length > 0 ? card('Releases', [table(releases)], { bodyClass: 'flush', actions: [el('span', { class: 'muted num' }, `${releases.length} recorded`)] }) : status ? emptyState('inbox', 'No release recorded yet.', 'The first deploy of this target will show here.') : null,
    status ? card('Roll back', [
      el('div', { class: 'field' }, el('label', { for: 'rollback-to' }, 'Back to'), select),
      el('p', { class: 'form-note' }, icon('alert'), 'Code only: the database is not rolled back. The commit it leaves is held: a scheduled run will not redeploy it until the branch moves on.'),
      message,
    ], { foot: [button('Roll back…', () => { void rollback(app, select.value, message) }, { class: 'danger' })] }) : null,
  )
}

function table(releases: Release[]): HTMLElement {
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ...['Commit', 'When', 'Status', 'Actor', 'Via', 'Client', 'Migrations', 'Backup', 'Note'].map((h) => el('th', { scope: 'col' }, h)))),
    el('tbody', {}, ...releases.map((r) => el('tr', {},
      el('td', { class: 'nowrap' }, el('code', {}, short(r.sha))),
      el('td', { class: 'nowrap num' }, when(r.at)),
      el('td', {}, pill(r.status === 'ok' ? 'ok' : 'err', r.status)),
      el('td', {}, r.actor ?? r.user),
      el('td', { class: 'muted' }, r.via ?? ''),
      el('td', { class: 'mono' }, r.client ?? ''),
      el('td', { class: 'mono wrap' }, r.migrations.join(', ')),
      el('td', { class: 'mono wrap' }, r.backup ?? ''),
      el('td', { class: 'wrap' }, r.note ?? ''),
    )))))
}

async function rollback(app: App, to: string, message: HTMLElement): Promise<void> {
  const t = app.current
  if (!t) return
  const ok = await confirmDialog({
    title: `Roll back ${t.name}?`,
    context: `${t.ssh} · ${t.dir}${app.hello ? ` · host ${app.hello.host}` : ''}`,
    lines: [
      to ? `Back to ${short(to)}.` : 'Back to the last healthy release.',
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
    reply = await app.api.post<CommandReply>('rollback', { target: t.name, confirm: true, confirmedTarget: t, ...(t.protected ? { confirmName: t.name } : {}), ...(to ? { to } : {}) })
  } catch (error) {
    replace(message, problem(undefined, error))
    void app.noticeChange(error)
    return
  }
  const result = reply.result as DetachResult | undefined
  if (reply.ok && result?.runId) {
    replace(message)
    app.watch(result.runId, `rollback ${result.runId}`)
    return
  }
  replace(message, problem(reply))
}
