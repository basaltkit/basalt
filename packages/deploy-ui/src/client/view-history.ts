import type { DetachResult, Release } from '@basaltkit/deploy/protocol'
import type { App } from './app.js'
import { confirmDialog } from './dialog.js'
import { button, el, replace, when } from './dom.js'
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
    el('div', { class: 'row' }, el('h2', { id: 'history-title' }, 'History'), button('Refresh', () => { void app.refreshStatus() })),
    !status ? el('p', { class: 'muted' }, 'Load the status first.') : null,
    releases.length > 0 ? table(releases) : status ? el('p', { class: 'muted' }, 'No release recorded yet.') : null,
    status ? el('div', { class: 'panel' },
      el('h3', {}, 'Roll back'),
      el('div', { class: 'field' }, el('label', { for: 'rollback-to' }, 'Back to'), select),
      el('p', { class: 'muted' }, 'Code only: the database is not rolled back. The commit it leaves is held: a scheduled run will not redeploy it until the branch moves on.'),
      button('Roll back…', () => { void rollback(app, select.value, message) }, { class: 'danger' }),
      message) : null,
  )
}

function table(releases: Release[]): HTMLElement {
  return el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, ...['Commit', 'When', 'Status', 'Actor', 'Via', 'Client', 'Migrations', 'Backup', 'Note'].map((h) => el('th', {}, h)))),
    el('tbody', {}, ...releases.map((r) => el('tr', {},
      el('td', {}, el('code', {}, short(r.sha))),
      el('td', {}, when(r.at)),
      el('td', {}, el('span', { class: r.status === 'ok' ? 'status-ok' : 'status-err' }, r.status)),
      el('td', {}, r.actor ?? r.user),
      el('td', {}, r.via ?? ''),
      el('td', {}, r.client ?? ''),
      el('td', {}, r.migrations.join(', ')),
      el('td', {}, r.backup ?? ''),
      el('td', {}, r.note ?? ''),
    )))))
}

async function rollback(app: App, to: string, message: HTMLElement): Promise<void> {
  const t = app.current
  if (!t) return
  const ok = await confirmDialog({
    title: `Roll back ${t.name}?`,
    lines: [
      `${t.ssh} · ${t.dir}${app.hello ? ` · host ${app.hello.host}` : ''}`,
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
