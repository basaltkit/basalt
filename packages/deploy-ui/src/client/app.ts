import type { HelloEvent, PlanResult, StatusResult } from '@basaltkit/deploy/protocol'
import { ApiError, type Api } from './api.js'
import { confirmDialog } from './dialog.js'
import { button, el, replace } from './dom.js'
import type { CommandReply, TargetsReply, TargetView } from './messages.js'
import { describe } from './reply.js'
import { renderHistory } from './view-history.js'
import { renderPlan } from './view-plan.js'
import { RunView } from './view-run.js'
import { renderStatus } from './view-status.js'
import { renderTargets } from './view-targets.js'

export type Screen = 'targets' | 'status' | 'plan' | 'history' | 'run'

export interface Shell {
  nav: HTMLElement
  bar: HTMLElement
  main: HTMLElement
  session: HTMLElement
}

const SCREENS: Array<[Screen, string]> = [['status', 'Status'], ['plan', 'Plan & deploy'], ['history', 'History'], ['run', 'Run'], ['targets', 'Targets']]

/** Per-target state the screens render; every server string in it is shown as text only. */
export class App {
  targets: TargetsReply = { path: '', exists: false, targets: [] }
  current: TargetView | undefined
  hello: HelloEvent | undefined
  statusReply: CommandReply | undefined
  planReply: CommandReply | undefined
  run: RunView | undefined
  screen: Screen = 'targets'
  statusBusy = false
  planBusy = false
  stopped = false

  constructor(readonly api: Api, readonly shell: Shell, readonly storage: Storage | undefined) {}

  get status(): StatusResult | undefined {
    return this.statusReply?.result as StatusResult | undefined
  }

  get plan(): PlanResult | undefined {
    return this.planReply?.result as PlanResult | undefined
  }

  async start(): Promise<void> {
    replace(this.shell.session, button('Quit', () => { void this.quit() }, { class: 'danger' }))
    await this.loadTargets()
    const first = this.targets.targets[0]
    if (first) {
      this.select(first.name)
      this.show('status')
      await this.refreshStatus()
    } else this.show('targets')
  }

  async loadTargets(): Promise<void> {
    this.targets = await this.api.post<TargetsReply>('targets')
    if (this.current && !this.targets.targets.some((t) => t.name === this.current?.name)) this.current = undefined
    if (this.current) this.current = this.targets.targets.find((t) => t.name === this.current?.name)
  }

  /** The server refused because the target changed after the confirmation: show the file's current values. */
  async noticeChange(error: unknown): Promise<void> {
    if (!(error instanceof ApiError) || error.body['changed'] !== true) return
    try {
      await this.loadTargets()
    } catch {
      return
    }
    this.renderNav()
    this.renderBar()
  }

  select(name: string): void {
    const found = this.targets.targets.find((t) => t.name === name)
    if (!found || found.name === this.current?.name) return
    this.current = found
    this.hello = undefined
    this.statusReply = undefined
    this.planReply = undefined
  }

  show(screen: Screen): void {
    this.screen = screen
    this.renderNav()
    this.renderBar()
    const main = this.shell.main
    if (screen === 'targets') return replace(main, renderTargets(this))
    if (!this.current) return replace(main, el('p', {}, 'Add a target first.'), button('Targets', () => this.show('targets')))
    if (screen === 'status') return replace(main, renderStatus(this))
    if (screen === 'plan') return replace(main, renderPlan(this))
    if (screen === 'history') return replace(main, renderHistory(this))
    replace(main, this.run ? this.run.element : el('p', { class: 'muted' }, 'No run in this tab yet: start one from Plan & deploy, or attach from Status.'))
  }

  /** Re-renders the current screen (after a state change). */
  refresh(): void {
    this.show(this.screen)
  }

  renderNav(): void {
    const select = el('select', { aria: { label: 'Target' }, on: { change: (event) => { this.select((event.target as HTMLSelectElement).value); this.refresh(); if (this.current) void this.refreshStatus() } } },
      ...this.targets.targets.map((t) => {
        const option = el('option', { value: t.name }, t.name)
        option.selected = t.name === this.current?.name
        return option
      }))
    replace(this.shell.nav,
      this.targets.targets.length > 0 ? select : null,
      ...SCREENS.map(([screen, label]) => button(label, () => this.show(screen), screen === this.screen ? { aria: { current: 'page' } } : {})))
  }

  /** "Am I about to deploy production?": name, destination, the server's host name and the app — on every screen. */
  renderBar(): void {
    const t = this.current
    if (!t) return replace(this.shell.bar)
    const status = this.status
    replace(this.shell.bar,
      el('strong', {}, t.name), ` · ${t.ssh}${t.port ? `:${t.port}` : ''} · ${t.dir}`,
      this.hello ? ` · host ${this.hello.host} · deploy ${this.hello.version}` : '',
      status ? ` · app ${status.app}` : '',
      t.protected ? el('strong', { class: 'status-err' }, ' · PROTECTED') : '')
  }

  async refreshStatus(): Promise<void> {
    const t = this.current
    if (!t) return
    this.statusBusy = true
    if (this.screen === 'status') this.refresh()
    try {
      this.statusReply = await this.api.post<CommandReply>('status', { target: t.name })
      if (this.statusReply.hello) this.hello = this.statusReply.hello
    } catch (error) {
      this.statusReply = { ok: false, failure: { code: 'local', message: describe(error) }, diagnostics: [] }
    } finally {
      this.statusBusy = false
    }
    if (this.current?.name === t.name) this.refresh()
  }

  async runPlan(): Promise<void> {
    const t = this.current
    if (!t) return
    this.planBusy = true
    this.planReply = undefined
    this.refresh()
    try {
      this.planReply = await this.api.post<CommandReply>('plan', { target: t.name })
      if (this.planReply.hello) this.hello = this.planReply.hello
    } catch (error) {
      this.planReply = { ok: false, failure: { code: 'local', message: describe(error) }, diagnostics: [] }
    } finally {
      this.planBusy = false
    }
    if (this.current?.name === t.name) this.refresh()
  }

  /** A run to watch: a new view, attached from the seq this tab last saw (or 0). */
  watch(runId: string, title: string, fromStart = false): RunView {
    if (this.run?.runId === runId && !this.run.ended && this.run.following) {
      this.show('run')
      return this.run
    }
    this.run?.stop()
    const t = this.current as TargetView
    this.run = new RunView(this, t, title, runId)
    this.show('run')
    void this.run.attach(fromStart ? 0 : this.run.resumeSeq())
    return this.run
  }

  /** An attended stream (env, an attended run): it stops if this page closes. */
  attended(title: string, route: 'env' | 'run', body: Record<string, unknown>): RunView {
    this.run?.stop()
    const t = this.current as TargetView
    this.run = new RunView(this, t, title, undefined)
    this.show('run')
    void this.run.streamAttended(route, body)
    return this.run
  }

  async quit(): Promise<void> {
    const watching = this.run?.following === true
    const ok = await confirmDialog({
      title: 'Quit the deploy UI?',
      lines: [
        'The local server stops and this page stops working.',
        watching ? 'A run is being watched: detached runs go on on the server (re-attach later); an attended one stops at its next step.' : 'Detached runs go on on the server.',
      ],
      confirmLabel: 'Quit',
    })
    if (!ok) return
    this.run?.stop()
    try {
      await this.api.post('quit')
    } catch {
      // Already gone.
    }
    this.stopped = true
    replace(this.shell.main, el('p', {}, 'The deploy UI has stopped. You can close this tab.'))
    replace(this.shell.nav)
    replace(this.shell.session)
  }
}
