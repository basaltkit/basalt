import type { CancelResult, DeployEvent, StepId } from '@basaltkit/deploy/protocol'
import type { App } from './app.js'
import { ApiError } from './api.js'
import { confirmDialog } from './dialog.js'
import { append, button, el, replace } from './dom.js'
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
    this.stateLine = el('p', { class: 'muted', role: 'status', aria: { live: 'polite' } })
    this.steps = el('ol', { class: 'steps', aria: { label: 'Steps' } })
    this.findings = el('ul', { aria: { label: 'Findings' } })
    this.log = el('ol', { class: 'log', aria: { label: 'Log' } })
    this.outcome = el('div')
    this.actions = el('div', { class: 'row' })
    this.diagnostics = el('pre', { class: 'diagnostics', hidden: true })
    this.element = el('section', { aria: { labelledby: 'run-title' } },
      el('h2', { id: 'run-title' }, title),
      el('p', { class: 'muted' }, `${target.name} · ${target.ssh} · ${target.dir}`),
      this.stateLine, this.actions,
      el('h3', {}, 'Steps'), this.steps,
      this.findings,
      el('h3', {}, 'Log'), this.log,
      this.outcome,
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
    if (fromSeq > 0) this.note(`(resuming from event ${fromSeq}: earlier events were shown before; "Show from the start" replays them)`)
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
      }
    } finally {
      this.following = false
      if (!this.ended) this.setState(this.controller.signal.aborted ? 'Stopped watching (the run goes on on the server).' : 'The stream ended.')
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
    if (message.state === 'connecting') return this.setState(`Connecting to ${this.target.ssh}…`)
    if (message.state === 'reconnecting') {
      return this.setState(`Connection lost (${clean(message.reason)}); reconnecting in ${Math.round((message.retryInMs ?? 0) / 1000)} s from event ${this.lastSeq === undefined ? 0 : this.lastSeq + 1}…`)
    }
    this.ended = true
    if (message.exitCode !== undefined) this.exitCode = message.exitCode
    if (this.runId && message.exitCode !== undefined && !message.code) {
      this.runFinished = true
      if (message.reason) this.note(`(${clean(message.reason)})`)
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
    if (!known) return this.line('warn', `an event this UI does not know (${event.type}): ignored`)
    switch (event.type) {
      case 'hello':
        return
      case 'step-start': {
        const node = el('li', {}, `▸ ${event.title} …`)
        this.stepNodes.set(event.id, node)
        this.stepTitles.set(event.id, event.title)
        this.steps.append(node)
        this.setState(`Step: ${event.title}`)
        return
      }
      case 'step-end': {
        const node = this.stepNodes.get(event.id) ?? el('li')
        const mark = event.status === 'ok' ? '✓' : event.status === 'skipped' ? '–' : '✗'
        // A step that started before the resume point has no node: its id names it.
        const title = this.stepTitles.get(event.id) ?? event.id
        replace(node, el('span', { class: event.status === 'ok' ? 'status-ok' : event.status === 'skipped' ? 'muted' : 'status-err' }, `${mark} ${title}`), ` — ${event.status}, ${(event.durationMs / 1000).toFixed(1)} s`)
        if (!node.parentNode) this.steps.append(node)
        return
      }
      case 'log':
        return this.line(event.level, event.text, event.source)
      case 'finding':
        this.findings.append(el('li', {}, el('strong', { class: event.level === 'error' ? 'status-err' : 'status-warn' }, event.level === 'error' ? 'Error ' : 'Warning '), event.message, event.fix ? el('div', {}, 'Fix: ', el('code', {}, event.fix)) : null))
        return
      case 'prompt':
        return this.line('warn', `the deploy asks: ${event.message} (answer it in the form and run again)`)
      case 'result':
        this.outcome.append(resultBanner(event.command, event.data))
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
        return this.line('warn', 'an unexpected wrapped event was ignored')
    }
  }

  private line(level: string, textValue: string, source?: string): void {
    if (this.log.childElementCount >= MAX_LOG_LINES) {
      this.log.firstElementChild?.remove()
      this.dropped++
      this.setDropped()
    }
    const mark = level === 'error' ? '✗ ' : level === 'warn' ? '! ' : ''
    this.log.append(el('li', { class: level === 'error' || level === 'warn' ? level : '' }, mark, source ? el('span', { class: 'src' }, `[${source}] `) : null, textValue))
  }

  private note(textValue: string): void {
    this.log.append(el('li', { class: 'src' }, textValue))
  }

  private setDropped(): void {
    this.stateLine.dataset['dropped'] = String(this.dropped)
  }

  private setState(textValue: string): void {
    replace(this.stateLine, textValue, this.dropped > 0 ? ` (${this.dropped} older log lines dropped from the page)` : '')
  }

  private finish(): void {
    // Status is refreshed once after any action (no polling loop).
    void this.app.refreshStatus()
    if (this.failed && this.exitCode === undefined) {
      const reconnectable = this.runId !== undefined
      this.setState(`Stopped: ${clean(this.failed.reason ?? this.failed.code)}`)
      this.outcome.append(banner('err', this.failed.reason ?? 'the stream ended', [this.failed.hint ?? '', reconnectable ? 'The run may still be going on the server: re-attach to see.' : ''], [], this.failed.code))
    } else if (this.exitCode === 0) {
      this.setState('Done.')
      this.outcome.append(banner('ok', 'Finished: exit 0'))
    } else {
      this.setState(`Finished with exit ${this.exitCode ?? 'unknown'}`)
      if (!this.lastError) this.outcome.append(banner('err', `Finished with exit ${this.exitCode ?? 'unknown'}`))
    }
    this.renderActions()
  }

  private renderActions(): void {
    const buttons: HTMLElement[] = []
    if (this.runId && !this.ended && this.following) {
      buttons.push(button(this.cancels > 0 ? 'Cancel again (stop now)…' : 'Cancel…', () => { void this.cancel(this.cancels > 0) }, { class: 'danger' }))
      buttons.push(button('Stop watching', () => this.stop()))
    }
    if (this.runId && !this.following) {
      // A finished run has nothing more to attach to: only a replay makes sense.
      if (!this.runFinished) buttons.push(button('Re-attach', () => { void this.attach(this.lastSeq === undefined ? 0 : this.lastSeq + 1) }, { class: 'primary' }))
      buttons.push(button('Show from the start', () => { this.app.watch(this.runId as string, `run ${this.runId}`, true) }, this.runFinished ? { class: 'primary' } : {}))
    }
    if (!this.following) buttons.push(button('Refresh status', () => { void this.app.refreshStatus().then(() => this.app.show('status')) }))
    replace(this.actions, ...buttons)
  }

  /** Two separate confirmations: the second one ends the deploy at once. */
  async cancel(second: boolean): Promise<void> {
    if (!this.runId) return
    const ok = await confirmDialog(second
      ? {
        title: 'Stop the deploy NOW?',
        lines: [
          'This ends the deploy at once, mid-step.',
          el('strong', {}, 'A migration may be left half-applied'),
          'The restore command for the pre-deploy dump is in the log. The lock is left stale.',
        ],
        confirmLabel: 'Stop it now',
        danger: true,
      }
      : {
        title: `Cancel the run on ${this.target.name}?`,
        lines: [
          'It stops at the next step boundary before the migration; from the migration on, the deploy finishes first.',
          'A second cancel would stop it at once. If this run was already cancelled once (from a terminal or another session), nothing is sent now: you are asked again first.',
        ],
        confirmLabel: 'Cancel the run',
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
      this.note(result?.second ? 'cancel sent a second time: the deploy stops at once' : 'cancel sent: the deploy stops at its next safe point')
      this.renderActions()
      return
    }
    this.outcome.append(problem(reply) as HTMLElement)
  }
}

function resultBanner(command: string, data: unknown): HTMLElement {
  const d = (data ?? {}) as Record<string, unknown>
  if (command === 'run') {
    return banner(d['status'] === 'ok' ? 'ok' : 'err', `Release ${clean(d['sha']).slice(0, 12)}: ${clean(d['status'])}`, [
      d['url'] ? `${clean(d['url'])}` : '',
      Array.isArray(d['migrations']) && d['migrations'].length > 0 ? `migrations: ${d['migrations'].map(clean).join(', ')}` : '',
      d['note'] ? clean(d['note']) : '',
    ])
  }
  if (command === 'rollback') return banner(d['status'] === 'ok' ? 'ok' : 'err', `Rolled back to ${clean(d['to']).slice(0, 12)}: ${clean(d['status'])}`, [`${clean(d['held']).slice(0, 12)} is held`])
  if (command === 'env') {
    const changes = Array.isArray(d['changes']) ? d['changes'] as Array<Record<string, unknown>> : []
    return banner('ok', `.env written (${changes.length} change${changes.length === 1 ? '' : 's'})`, changes.map((c) => `${clean(c['kind'])} ${clean(c['key'])}: ${clean(c['reason'])}`))
  }
  return banner('ok', `${clean(command)} result`)
}
