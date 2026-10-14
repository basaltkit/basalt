import type { StatusResult } from '@basaltkit/deploy/protocol'
import type { App } from './app.js'
import { button, card, el, emptyState, kv, pageHead, pill, quiet, when, type Child } from './dom.js'
import { icon } from './icons.js'
import { banner, diagnosticsBlock, problem } from './reply.js'
import { short } from './sanitize.js'

/** Status: from `StatusResult` — release, process, lock, active and last run, hold. Refresh is manual (and once after an action). */
export function renderStatus(app: App): HTMLElement {
  const reply = app.statusReply
  const status = app.status
  return el('section', { aria: { labelledby: 'status-title' } },
    pageHead('status-title', 'Status', 'What runs on the server now: the release, the process, the lock and the last runs.',
      el('button', { type: 'button', disabled: app.statusBusy, on: { click: () => { void app.refreshStatus() } } }, icon('refresh'), app.statusBusy ? 'Refreshing…' : 'Refresh')),
    !reply && !app.statusBusy ? emptyState('status', 'Not loaded yet.', 'Refresh to ask the server for its state.') : null,
    !reply && app.statusBusy ? emptyState('refresh', 'Asking the server…', 'Over your ssh; this can take a few seconds.') : null,
    reply && !status ? problem(reply) : null,
    ...(status ? statusPanels(app, status) : []),
    status && reply?.error ? problem(reply) : null,
    reply && reply.diagnostics.length > 0 && status ? diagnosticsBlock(reply.diagnostics) : null,
  )
}

function statusPanels(app: App, s: StatusResult): Child[] {
  const current = s.releases.find((r) => r.status === 'ok')
  const panels: Child[] = []
  if (s.hold) {
    panels.push(banner('warn', `Commit ${short(s.hold.sha)} is held since ${when(s.hold.at)} by ${s.hold.actor}`, [
      s.hold.note,
      'A run refuses it until the branch moves on; "Deploy anyway" in Plan & deploy overrides that once.',
    ]))
  }
  if (s.activeRun) {
    const run = s.activeRun
    panels.push(card('Active run', [
      el('p', { class: 'lead' }, run.alive ? pill('run', 'alive') : pill('warn', 'not seen alive'), el('span', { class: 'mono' }, run.runId)),
      kv([['Command', run.command], ['Actor', run.actor], ['Started', el('span', { class: 'num' }, when(run.startedAt))]]),
    ], { class: 'accent', actions: [button('Attach', () => { app.watch(run.runId, `${run.command} ${run.runId}`) }, { class: 'primary' })] }))
  }
  const releaseCard = card('Current release', current
    ? [
      el('p', { class: 'lead' }, pill('ok', 'healthy'), el('code', {}, short(current.sha))),
      kv([
        ['Deployed', el('span', { class: 'num' }, when(current.at))],
        ['By', `${current.actor ?? current.user}${current.via ? ` via ${current.via}` : ''}`],
        current.migrations.length > 0 ? ['Migrations', el('span', { class: 'mono' }, current.migrations.join(', '))] : null,
      ]),
    ]
    : [el('p', { class: 'muted' }, 'No healthy release recorded yet.')])
  const processCard = card('Process', s.process.kind === 'pm2'
    ? [
      el('p', { class: 'lead' }, el('span', { class: 'mono' }, `pm2 ${s.process.name}`), quiet(': '), s.process.running ? pill('ok', 'running') : pill('err', 'not running'), s.process.status ? el('span', { class: 'muted' }, ` (${s.process.status})`) : ''),
      kv([['Manager', 'pm2'], ['Name', el('span', { class: 'mono' }, s.process.name)], s.process.pid !== undefined ? ['PID', el('span', { class: 'num mono' }, String(s.process.pid))] : null]),
    ]
    : [el('pre', { class: 'diagnostics' }, s.process.lines.join('\n'))])
  const lock = s.lock
  const lockCard = card('Lock', !lock
    ? [el('p', { class: 'lead' }, pill('ok', 'free'), el('span', { class: 'muted' }, 'Free. No deploy holds it.'))]
    : [
      el('p', { class: 'lead' },
        lock.corrupt ? pill('err', 'corrupt') : lock.stale ? pill('warn', 'stale') : pill('run', 'held'),
        lock.corrupt ? el('strong', { class: 'status-err' }, 'Corrupt lock file. ') : null),
      lock.holder ? el('p', {}, `Held by pid ${lock.holder.pid} on ${lock.holder.host} — ${lock.holder.actor}, ${lock.holder.command}, since ${when(lock.holder.startedAt)}`) : null,
      lock.stale ? el('p', { class: 'status-warn' }, el('strong', {}, ' (stale: that process is gone)')) : null,
    ])
  const lastRunCard = s.lastRun ? lastRun(app, s.lastRun) : card('Last run', [el('p', { class: 'muted' }, 'No run recorded yet.')])
  panels.push(el('div', { class: 'grid-2' }, releaseCard, processCard, lockCard, lastRunCard))
  return panels
}

function lastRun(app: App, run: NonNullable<StatusResult['lastRun']>): HTMLElement {
  return card('Last run', [
    el('p', { class: 'lead' },
      run.complete ? pill(run.exitCode === 0 ? 'ok' : 'err', `exit ${run.exitCode}`) : pill('warn', 'did not end with done'),
      el('span', { class: 'mono' }, run.runId)),
    kv([['Command', run.command || 'unknown command'], run.endedAt ? ['Ended', el('span', { class: 'num' }, when(run.endedAt))] : null]),
  ], { actions: [button('Show its log', () => { app.watch(run.runId, `${run.command} ${run.runId}`, true) }, { class: 'sm' })] })
}
