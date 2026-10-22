import type { StatusResult } from '@basaltkit/deploy/protocol'
import type { App } from './app.js'
import { button, card, el, emptyState, kv, pageHead, pill, quiet, when, type Child } from './dom.js'
import { t } from './i18n.js'
import { icon } from './icons.js'
import { banner, diagnosticsBlock, problem } from './reply.js'
import { short } from './sanitize.js'

/** Status: from `StatusResult` — release, process, lock, active and last run, hold. Refresh is manual (and once after an action). */
export function renderStatus(app: App): HTMLElement {
  const reply = app.statusReply
  const status = app.status
  return el('section', { aria: { labelledby: 'status-title' } },
    pageHead('status-title', t('screen.status'), t('status.sub'),
      el('button', { type: 'button', disabled: app.statusBusy, on: { click: () => { void app.refreshStatus() } } }, icon('refresh'), app.statusBusy ? t('refreshing') : t('refresh'))),
    !reply && !app.statusBusy ? emptyState('status', t('status.notLoaded'), t('status.notLoadedText')) : null,
    !reply && app.statusBusy ? emptyState('refresh', t('status.asking'), t('status.askingText')) : null,
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
    panels.push(banner('warn', t('status.held', { sha: short(s.hold.sha), at: when(s.hold.at), actor: s.hold.actor }), [
      s.hold.note,
      t('status.heldHelp'),
    ]))
  }
  if (s.activeRun) {
    const run = s.activeRun
    panels.push(card(t('status.activeRun'), [
      el('p', { class: 'lead' }, run.alive ? pill('run', t('status.alive')) : pill('warn', t('status.notSeenAlive')), el('span', { class: 'mono' }, run.runId)),
      kv([[t('status.command'), run.command], [t('status.actor'), run.actor], [t('status.started'), el('span', { class: 'num' }, when(run.startedAt))]]),
    ], { class: 'accent', actions: [button(t('status.attach'), () => { app.watch(run.runId, `${run.command} ${run.runId}`) }, { class: 'primary' })] }))
  }
  const releaseCard = card(t('status.currentRelease'), current
    ? [
      el('p', { class: 'lead' }, pill('ok', t('status.healthy')), el('code', {}, short(current.sha))),
      kv([
        [t('status.deployed'), el('span', { class: 'num' }, when(current.at))],
        [t('status.by'), current.via ? t('status.via', { who: current.actor ?? current.user, via: current.via }) : current.actor ?? current.user],
        current.migrations.length > 0 ? [t('status.migrations'), el('span', { class: 'mono' }, current.migrations.join(', '))] : null,
      ]),
    ]
    : [el('p', { class: 'muted' }, t('status.noHealthy'))])
  const processCard = card(t('status.process'), s.process.kind === 'pm2'
    ? [
      el('p', { class: 'lead' }, el('span', { class: 'mono' }, `pm2 ${s.process.name}`), quiet(': '), s.process.running ? pill('ok', t('status.running')) : pill('err', t('status.notRunning')), s.process.status ? el('span', { class: 'muted' }, ` (${s.process.status})`) : ''),
      kv([[t('status.manager'), 'pm2'], [t('status.name'), el('span', { class: 'mono' }, s.process.name)], s.process.pid !== undefined ? ['PID', el('span', { class: 'num mono' }, String(s.process.pid))] : null]),
    ]
    : [el('pre', { class: 'diagnostics' }, s.process.lines.join('\n'))])
  const lock = s.lock
  const lockCard = card(t('status.lock'), !lock
    ? [el('p', { class: 'lead' }, pill('ok', t('status.free')), el('span', { class: 'muted' }, t('status.freeText')))]
    : [
      el('p', { class: 'lead' },
        lock.corrupt ? pill('err', t('status.corrupt')) : lock.stale ? pill('warn', t('status.stale')) : pill('run', t('status.heldPill')),
        lock.corrupt ? el('strong', { class: 'status-err' }, t('status.corruptLock')) : null),
      lock.holder ? el('p', {}, t('status.lockHolder', { ...lock.holder, since: when(lock.holder.startedAt) })) : null,
      lock.stale ? el('p', { class: 'status-warn' }, el('strong', {}, t('status.staleNote'))) : null,
    ])
  const lastRunCard = s.lastRun ? lastRun(app, s.lastRun) : card(t('status.lastRun'), [el('p', { class: 'muted' }, t('status.noRun'))])
  panels.push(el('div', { class: 'grid-2' }, releaseCard, processCard, lockCard, lastRunCard))
  return panels
}

function lastRun(app: App, run: NonNullable<StatusResult['lastRun']>): HTMLElement {
  return card(t('status.lastRun'), [
    el('p', { class: 'lead' },
      run.complete ? pill(run.exitCode === 0 ? 'ok' : 'err', t('status.exit', { code: run.exitCode })) : pill('warn', t('status.noDone')),
      el('span', { class: 'mono' }, run.runId)),
    kv([[t('status.command'), run.command || t('status.unknownCommand')], run.endedAt ? [t('status.ended'), el('span', { class: 'num' }, when(run.endedAt))] : null]),
  ], { actions: [button(t('status.showLog'), () => { app.watch(run.runId, `${run.command} ${run.runId}`, true) }, { class: 'sm' })] })
}
