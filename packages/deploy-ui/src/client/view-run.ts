import type { CancelResult, DeployEvent, StepId } from '@basaltkit/deploy/protocol'
import type { App } from './app.js'
import { ApiError } from './api.js'
import { confirmDialog } from './dialog.js'
import { append, button, el, quiet, replace } from './dom.js'
import { serverText, t, type MessageKey } from './i18n.js'
import { icon } from './icons.js'
import { findingItem } from './view-plan.js'
import type { CommandReply, StreamMessage, TargetView } from './messages.js'
import { banner, describe, errorBanner, problem } from './reply.js'
import { clean } from './sanitize.js'

/** The log lines kept in the page; the full log stays on the server ("Show from the start" replays it). */
export const MAX_LOG_LINES = 5000
const SEQ_KEY = (runId: string) => `basalt-deploy-ui:seq:${runId}`

/**
 * One run, live: steps, findings, the log and a final banner, fed by stream
 * messages. Dispatch is on the event's `type` only — never on its text, so a
 * build that prints a fake `done` is a log line.
 */
export class RunView {
  readonly element: HTMLElement
  ended = false
  following = false
  /** The run's last seq this view showed (the resume key). */
  lastSeq: number | undefined
  private controller: AbortController | undefined
  private readonly stateLine: HTMLElement
  private readonly steps: HTMLElement
  private readonly stepNodes = new Map<StepId, HTMLElement>()
  private readonly stepTitles = new Map<StepId, string>()
  /** The run's own `done` was seen (or attach said it had finished): nothing more will come. */
  private runFinished = false
  private readonly findings: HTMLElement
  private readonly findingsCard: HTMLElement
  private readonly log: HTMLElement
  private readonly outcome: HTMLElement
  private readonly actions: HTMLElement
  private readonly diagnostics: HTMLElement
  private dropped = 0
  private cancels = 0
  private exitCode: number | undefined
  private failed: { code?: string; reason?: string; hint?: string } | undefined
  private lastError: DeployEvent | undefined

  constructor(private readonly app: App, private readonly target: TargetView, title: string, readonly runId: string | undefined) {
    this.stateLine = el('p', { class: 'run-state', role: 'status', aria: { live: 'polite' } })
    this.steps = el('ol', { class: 'steps', aria: { label: t('run.steps') } })
    this.findings = el('ul', { class: 'findings', aria: { label: t('run.findings') } })
    this.log = el('ol', { class: 'log', aria: { label: t('run.log') } })
    this.outcome = el('div', { class: 'run-outcome' })
    this.actions = el('div', { class: 'page-actions' })
    this.diagnostics = el('pre', { class: 'diagnostics', hidden: true })
    this.findingsCard = el('div', { class: 'card', hidden: true },
      el('div', { class: 'card-head' }, el('h3', {}, t('run.findings'))), el('div', { class: 'card-body flush' }, this.findings))
    this.element = el('section', { aria: { labelledby: 'run-title' } },
      el('header', { class: 'page-head' },
        el('div', { class: 'page-title' }, el('h2', { id: 'run-title', class: 'mono-title' }, title),
          el('p', { class: 'page-sub' }, `${target.name} · ${target.ssh} · ${target.dir}`)),
        this.actions),
      this.stateLine,
      this.outcome,
      el('div', { class: 'run-grid' },
        el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h3', {}, t('run.steps'))), el('div', { class: 'card-body' }, this.steps)),
        el('div', { class: 'console' },
          el('div', { class: 'console-head' }, el('h3', {}, icon('terminal'), t('run.log')), el('span', { class: 'console-meta' }, target.name)),
          this.log)),
      this.findingsCard,
      this.diagnostics)
    this.renderActions()
  }

  /** Where to resume: the seq after the last one this tab saw for this run, kept in sessionStorage (not a secret). */
  resumeSeq(): number {
    if (!this.runId) return 0
    try {
      const stored = this.app.storage?.getItem(SEQ_KEY(this.runId))
      const seq = stored === null || stored === undefined ? NaN : Number(stored)
      return Number.isSafeInteger(seq) && seq >= 0 ? seq + 1 : 0
    } catch {
      return 0
    }
  }

  stop(): void {
    this.controller?.abort()
    this.following = false
  }

  async attach(fromSeq: number): Promise<void> {
    if (!this.runId) return
    if (fromSeq > 0) this.note(t('run.resuming', { seq: fromSeq }))
    await this.consume('attach', { target: this.target.name, runId: this.runId, fromSeq })
  }

  async streamAttended(route: 'env' | 'run', body: Record<string, unknown>): Promise<void> {
    await this.consume(route, body)
  }

  private async consume(route: string, body: Record<string, unknown>): Promise<void> {
    this.controller = new AbortController()
    this.following = true
    this.ended = false
    this.failed = undefined
    this.renderActions()
    try {
      await this.app.api.stream(route, body, (message) => this.handle(message), this.controller.signal)
    } catch (error) {
      if (!this.controller.signal.aborted) {
        this.failed = { code: 'local', reason: describe(error) }
        replace(this.outcome, problem(undefined, error))
        void this.app.noticeChange(error)
      }
    } finally {
      this.following = false
      if (!this.ended) {
        this.settleSteps()
        this.setState(this.controller.signal.aborted ? t('run.stoppedWatching') : t('run.streamEnded'))
      }
      this.renderActions()
    }
  }

  handle(message: StreamMessage): void {
    switch (message.kind) {
      case 'hello':
        this.app.hello = message.hello
        this.app.renderBar()
        return
      case 'diagnostic':
        this.diagnostics.hidden = false
        append(this.diagnostics, `${message.text}\n`)
        return
      case 'state':
        return this.state(message)
      case 'event':
        return this.event(message.event, message.known)
    }
  }

  private state(message: Extract<StreamMessage, { kind: 'state' }>): void {
    if (message.state === 'connecting') return this.setState(t('run.connecting', { ssh: this.target.ssh }), 'live')
    if (message.state === 'reconnecting') {
      return this.setState(t('run.reconnecting', { reason: clean(message.reason), seconds: Math.round((message.retryInMs ?? 0) / 1000), seq: this.lastSeq === undefined ? 0 : this.lastSeq + 1 }), 'live')
    }
    this.ended = true
    if (message.exitCode !== undefined) this.exitCode = message.exitCode
    if (this.runId && message.exitCode !== undefined && !message.code) {
      this.runFinished = true
      if (message.reason) this.note(`(${serverText(clean(message.reason))})`)
    }
    if (message.code) {
      this.failed = { code: message.code, ...(message.reason ? { reason: message.reason } : {}), ...(message.hint ? { hint: message.hint } : {}) }
    }
    this.finish()
  }

  private event(event: DeployEvent, known: boolean): void {
    this.lastSeq = event.seq
    if (this.runId) {
      try {
        this.app.storage?.setItem(SEQ_KEY(this.runId), String(event.seq))
      } catch {
        // No storage (private mode): resume from 0 instead.
      }
    }
    if (!known) return this.line('warn', t('run.unknownEvent', { type: event.type }))
    switch (event.type) {
      case 'hello':
        return
      case 'step-start': {
        const node = el('li', { class: 'step is-running' }, el('span', { class: 'step-icon', aria: { hidden: 'true' } }, '▸'), ' ', el('span', { class: 'step-title' }, event.title),
          el('span', { class: 'step-meta' }, quiet(' '), quiet('…'), el('span', { class: 'step-status', aria: { hidden: 'true' } }, t('step.running'))))
        this.stepNodes.set(event.id, node)
        this.stepTitles.set(event.id, event.title)
        this.steps.append(node)
        this.setState(t('run.step', { title: event.title }), 'live')
        return
      }
      case 'step-end': {
        const node = this.stepNodes.get(event.id) ?? el('li')
        const mark = event.status === 'ok' ? '✓' : event.status === 'skipped' ? '–' : '✗'
        // A step that started before the resume point has no node: its id names it.
        const title = this.stepTitles.get(event.id) ?? event.id
        node.className = `step is-${event.status === 'ok' ? 'ok' : event.status === 'skipped' ? 'skipped' : 'failed'}`
        // The text reads "✓ build — ok, 1.5 s"; the layout draws the mark as an icon and the duration in a column.
        replace(node, el('span', { class: 'step-icon', aria: { hidden: 'true' } }, mark), quiet(' '), el('span', { class: 'step-title' }, title),
          el('span', { class: 'step-meta' }, quiet(' — '), el('span', { class: 'step-status' }, stepStatus(event.status)), quiet(', '), el('span', { class: 'step-dur' }, `${(event.durationMs / 1000).toFixed(1)} s`)))
        if (!node.parentNode) this.steps.append(node)
        return
      }
      case 'log':
        return this.line(event.level, event.text, event.source, event.ts)
      case 'finding':
        this.findingsCard.hidden = false
        this.findings.append(findingItem(event))
        return
      case 'prompt':
        return this.line('warn', t('run.asks', { message: event.message }))
      case 'result':
        this.outcome.append(resultBanner(event.command, event.data, this.runId ? this.app.previewedRollbacks.get(this.runId) : undefined))
        return
      case 'error':
        this.lastError = event
        this.outcome.append(errorBanner(event))
        return
      case 'done':
        this.exitCode = event.exitCode
        if (this.runId) this.runFinished = true
        return
      case 'event':
        // Only the server unwraps attach; a nested wrapper here is a log-worthy oddity.
        return this.line('warn', t('run.wrapped'))
    }
  }

  private line(level: string, textValue: string, source?: string, ts?: string): void {
    if (this.log.childElementCount >= MAX_LOG_LINES) {
      this.log.firstElementChild?.remove()
      this.dropped++
      this.setDropped()
    }
    const mark = level === 'error' ? '✗ ' : level === 'warn' ? '! ' : ''
    const node = el('li', { class: level === 'error' || level === 'warn' || level === 'ok' ? level : '' }, mark, source ? el('span', { class: 'src' }, `[${source}] `) : null, textValue)
    // The time column is drawn from an attribute: the line's text stays exactly what the deploy printed.
    const time = /T(\d\d:\d\d:\d\d)/.exec(clean(ts))?.[1]
    if (time) node.dataset['ts'] = time
    this.log.append(node)
  }

  private note(textValue: string): void {
    this.log.append(el('li', { class: 'src' }, textValue))
  }

  /** A step still running when this view stopped following: its end is not known here (it is not drawn as running). */
  private settleSteps(): void {
    for (const node of this.stepNodes.values()) {
      if (!node.classList.contains('is-running')) continue
      node.classList.replace('is-running', 'is-aborted')
      const status = node.querySelector('.step-status')
      if (status) replace(status, t('run.noEnd'))
    }
  }

  private setDropped(): void {
    this.stateLine.dataset['dropped'] = String(this.dropped)
  }

  private setState(textValue: string, tone?: 'live' | 'ok' | 'err'): void {
    this.stateLine.className = `run-state${tone ? ` is-${tone}` : ''}`
    replace(this.stateLine, textValue, this.dropped > 0 ? t('run.dropped', { count: this.dropped }) : '')
  }

  private finish(): void {
    // Status is refreshed once after any action (no polling loop).
    void this.app.refreshStatus()
    this.settleSteps()
    if (this.failed && this.exitCode === undefined) {
      const reconnectable = this.runId !== undefined
      const reason = this.failed.reason === undefined ? undefined : serverText(clean(this.failed.reason))
      this.setState(t('run.stoppedBecause', { why: reason ?? clean(this.failed.code) }), 'err')
      this.outcome.append(banner('err', reason ?? t('run.streamEndedLower'), [this.failed.hint ? serverText(clean(this.failed.hint)) : '', reconnectable ? t('run.mayStillRun') : ''], [], this.failed.code))
    } else if (this.exitCode === 0) {
      this.setState(t('run.done'), 'ok')
      this.outcome.append(banner('ok', t('run.finishedOk')))
    } else {
      const finished = t('run.finishedWith', { code: this.exitCode ?? t('unknown') })
      this.setState(finished, 'err')
      if (!this.lastError) this.outcome.append(banner('err', finished))
    }
    this.renderActions()
  }

  private renderActions(): void {
    const buttons: HTMLElement[] = []
    if (this.runId && !this.ended && this.following) {
      buttons.push(button(this.cancels > 0 ? t('run.cancelAgain') : t('run.cancel'), () => { void this.cancel(this.cancels > 0) }, { class: 'danger' }))
      buttons.push(button(t('run.stopWatching'), () => this.stop()))
    }
    if (this.runId && !this.following) {
      // A finished run has nothing more to attach to: only a replay makes sense.
      if (!this.runFinished) buttons.push(button(t('run.reattach'), () => { void this.attach(this.lastSeq === undefined ? 0 : this.lastSeq + 1) }, { class: 'primary' }))
      buttons.push(button(t('run.fromStart'), () => { this.app.watch(this.runId as string, t('run.title', { runId: this.runId }), true) }, this.runFinished ? { class: 'primary' } : {}))
    }
    if (!this.following) buttons.push(button(t('run.refreshStatus'), () => { void this.app.refreshStatus().then(() => this.app.show('status')) }))
    replace(this.actions, ...buttons)
  }

  /** Two separate confirmations: the second one ends the deploy at once. */
  async cancel(second: boolean): Promise<void> {
    if (!this.runId) return
    const ok = await confirmDialog(second
      ? {
        title: t('run.stopNowTitle'),
        lines: [
          t('run.stopNowLine'),
          el('strong', {}, t('run.halfApplied')),
          t('run.restoreInLog'),
        ],
        confirmLabel: t('run.stopItNow'),
        danger: true,
      }
      : {
        title: t('run.cancelTitle', { name: this.target.name }),
        lines: [t('run.cancelLine'), t('run.cancelSecondLine')],
        confirmLabel: t('run.cancelRun'),
        danger: true,
      })
    if (!ok) return
    let reply: CommandReply
    try {
      reply = await this.app.api.post<CommandReply>('cancel', { target: this.target.name, runId: this.runId, confirm: true, ...(second ? { second: true } : {}) })
    } catch (error) {
      if (error instanceof ApiError && error.body['second'] === true && !second) return this.cancel(true)
      this.outcome.append(problem(undefined, error) as HTMLElement)
      return
    }
    if (reply.ok) {
      this.cancels++
      const result = reply.result as CancelResult | undefined
      this.note(result?.second ? t('run.cancelSentTwice') : t('run.cancelSent'))
      this.renderActions()
      return
    }
    this.outcome.append(problem(reply) as HTMLElement)
  }
}

function resultBanner(command: string, data: unknown, previewed?: string): HTMLElement {
  const d = (data ?? {}) as Record<string, unknown>
  if (command === 'run') {
    return banner(d['status'] === 'ok' ? 'ok' : 'err', t('run.release', { sha: clean(d['sha']).slice(0, 12), status: stepStatus(clean(d['status'])) }), [
      d['url'] ? `${clean(d['url'])}` : '',
      Array.isArray(d['migrations']) && d['migrations'].length > 0 ? t('run.migrations', { list: d['migrations'].map(clean).join(', ') }) : '',
      d['note'] ? clean(d['note']) : '',
    ])
  }
  if (command === 'rollback') {
    const to = clean(d['to'])
    return banner(d['status'] === 'ok' ? 'ok' : 'err', t('run.rolledBack', { sha: to.slice(0, 12), status: stepStatus(clean(d['status'])) }), [
      t('run.isHeld', { sha: clean(d['held']).slice(0, 12) }),
      // The releases moved between the preview and the run: say which commit the deploy chose.
      previewed && to && previewed !== to ? el('strong', {}, t('run.deployChose', { to: to.slice(0, 12), previewed: clean(previewed).slice(0, 12) })) : '',
    ])
  }
  if (command === 'env') {
    const changes = Array.isArray(d['changes']) ? d['changes'] as Array<Record<string, unknown>> : []
    return banner('ok', t('run.envWritten', { count: changes.length }), changes.map((c) => `${clean(c['kind'])} ${clean(c['key'])}: ${clean(c['reason'])}`))
  }
  return banner('ok', t('run.result', { command: clean(command) }))
}

/** A step's or a release's status in the page's language; one this UI does not know is shown as the server wrote it. */
function stepStatus(status: string): string {
  return status === 'ok' || status === 'skipped' || status === 'failed' ? t(`step.${status}` as MessageKey) : status
}
