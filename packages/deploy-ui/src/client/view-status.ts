import type { StatusResult } from '@basaltkit/deploy/protocol'
import type { App } from './app.js'
import { button, el, when, type Child } from './dom.js'
import { banner, diagnosticsBlock, problem } from './reply.js'
import { short } from './sanitize.js'

/** Status: from `StatusResult` — release, process, lock, active and last run, hold. Refresh is manual (and once after an action). */
export function renderStatus(app: App): HTMLElement {
  const reply = app.statusReply
  const status = app.status
  return el('section', { aria: { labelledby: 'status-title' } },
    el('div', { class: 'row' }, el('h2', { id: 'status-title' }, 'Status'), button(app.statusBusy ? 'Refreshing…' : 'Refresh', () => { void app.refreshStatus() }, { disabled: app.statusBusy })),
    !reply && !app.statusBusy ? el('p', { class: 'muted' }, 'Not loaded yet.') : null,
    reply && !status ? problem(reply) : null,
    ...(status ? statusPanels(app, status) : []),
    status && reply?.error ? problem(reply) : null,
    reply && reply.diagnostics.length > 0 && status ? diagnosticsBlock(reply.diagnostics) : null,
  )
}

function statusPanels(app: App, s: StatusResult): Child[] {
  const current = s.releases.find((r) => r.status === 'ok')
  const panels: Child[] = []
  panels.push(el('div', { class: 'panel' }, el('h3', {}, 'Current release'),
    current
      ? el('p', {}, el('code', {}, short(current.sha)), ` · ${when(current.at)} · ${current.actor ?? current.user}${current.via ? ` via ${current.via}` : ''}`)
      : el('p', { class: 'muted' }, 'No healthy release recorded yet.')))
  const process = s.process.kind === 'pm2'
    ? el('p', {}, `pm2 ${s.process.name}: `, el('strong', { class: s.process.running ? 'status-ok' : 'status-err' }, s.process.running ? 'running' : 'not running'), s.process.status ? ` (${s.process.status})` : '')
    : el('pre', { class: 'diagnostics' }, s.process.lines.join('\n'))
  panels.push(el('div', { class: 'panel' }, el('h3', {}, 'Process'), process))
  const lock = s.lock
  panels.push(el('div', { class: 'panel' }, el('h3', {}, 'Lock'),
    !lock ? el('p', {}, 'Free.')
      : el('p', {}, lock.corrupt ? el('strong', { class: 'status-err' }, 'Corrupt lock file. ') : null,
        lock.holder ? `Held by pid ${lock.holder.pid} on ${lock.holder.host} — ${lock.holder.actor}, ${lock.holder.command}, since ${when(lock.holder.startedAt)}` : '',
        lock.stale ? el('strong', { class: 'status-warn' }, ' (stale: that process is gone)') : null)))
  if (s.activeRun) {
    const run = s.activeRun
    panels.push(el('div', { class: 'panel' }, el('h3', {}, 'Active run'),
      el('p', {}, el('code', {}, run.runId), ` · ${run.command} by ${run.actor} since ${when(run.startedAt)} · `, run.alive ? 'alive' : el('strong', { class: 'status-warn' }, 'not seen alive')),
      el('div', { class: 'row' }, button('Attach', () => { app.watch(run.runId, `${run.command} ${run.runId}`) }, { class: 'primary' }))))
  }
  if (s.lastRun) {
    const run = s.lastRun
    panels.push(el('div', { class: 'panel' }, el('h3', {}, 'Last run'),
      el('p', {}, el('code', {}, run.runId), ` · ${run.command || 'unknown command'} · `,
        run.complete ? el('strong', { class: run.exitCode === 0 ? 'status-ok' : 'status-err' }, `exit ${run.exitCode}`) : el('strong', { class: 'status-warn' }, 'did not end with done'),
        run.endedAt ? ` · ${when(run.endedAt)}` : ''),
      el('div', { class: 'row' }, button('Show its log', () => { app.watch(run.runId, `${run.command} ${run.runId}`, true) }))))
  }
  if (s.hold) {
    panels.push(banner('warn', `Commit ${short(s.hold.sha)} is held since ${when(s.hold.at)} by ${s.hold.actor}`, [
      s.hold.note,
      'A run refuses it until the branch moves on; "Deploy anyway" in Plan & deploy overrides that once.',
    ]))
  }
  return panels
}
