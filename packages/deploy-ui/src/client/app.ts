import type { HelloEvent, PlanResult, StatusResult } from '@basaltkit/deploy/protocol'
import { ApiError, type Api, type ServerGone } from './api.js'
import { confirmDialog } from './dialog.js'
import { button, el, emptyState, quiet, replace, type Child } from './dom.js'
import { icon, type IconName } from './icons.js'
import type { CommandReply, TargetsReply, TargetView } from './messages.js'
import { describe } from './reply.js'
import { renderHistory } from './view-history.js'
import { renderPlan } from './view-plan.js'
import { RunView } from './view-run.js'
import { renderStatus } from './view-status.js'
import { renderTargets } from './view-targets.js'

export type Screen = 'targets' | 'status' | 'plan' | 'history' | 'run'

/** This tab's session (sessionStorage): the bearer token, and the key the server proves itself with. */
export const TOKEN_KEY = 'basalt-deploy-ui:token'
export const SERVER_KEY = 'basalt-deploy-ui:server-key'

/** Forgets this tab's session: after a stop it is worth nothing, and nothing should look like it still works. */
export function forgetSession(storage: Storage | undefined): void {
  try {
    storage?.removeItem(TOKEN_KEY)
    storage?.removeItem(SERVER_KEY)
  } catch {
    // No storage: nothing kept.
  }
}

export interface Shell {
  nav: HTMLElement
  bar: HTMLElement
  main: HTMLElement
  session: HTMLElement
}

const SCREENS: Array<[Screen, string, IconName]> = [['status', 'Status', 'status'], ['plan', 'Plan & deploy', 'plan'], ['history', 'History', 'history'], ['run', 'Run', 'run'], ['targets', 'Targets', 'targets']]

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
  /** The rollback target each previewed rollback showed, by run id: the run says when the deploy chose another. */
  readonly previewedRollbacks = new Map<string, string>()
  /** The commits between two releases never change: read once per target and pair. */
  private readonly ranges = new Map<string, Promise<CommandReply>>()

  constructor(readonly api: Api, readonly shell: Shell, readonly storage: Storage | undefined) {
    api.onGone = (error) => this.serverGone(error)
  }

  /**
   * The local server stopped, or something else answers on its port: every
   * form goes (typed answers with it), the session is forgotten, and the page
   * says what happened. Nothing is sent from here on.
   */
  serverGone(error: ServerGone): void {
    if (this.stopped) return
    this.stopped = true
    this.run?.stop()
    forgetSession(this.storage)
    replace(this.shell.main, el('div', { class: 'stopped' },
      emptyState('power', 'Disconnected', 'This page sends nothing from here on.'),
      el('div', { class: 'banner err', role: 'alert' },
        icon('error', 'icon banner-icon'),
        el('div', { class: 'banner-body' },
          el('strong', { class: 'banner-title' }, error.why === 'unverified' ? 'This page no longer talks to your deploy UI.' : 'The deploy UI has stopped.'),
          el('p', {}, error.message),
          el('p', {}, 'Nothing was sent. Detached runs go on on the server. Start basalt-deploy-ui again and open the URL it prints.')))))
    replace(this.shell.nav)
    this.clearBar()
    replace(this.shell.session)
  }

  get status(): StatusResult | undefined {
    return this.statusReply?.result as StatusResult | undefined
  }

  get plan(): PlanResult | undefined {
    return this.planReply?.result as PlanResult | undefined
  }

  async start(): Promise<void> {
    replace(this.shell.session, el('button', { type: 'button', class: 'ghost danger', on: { click: () => { void this.quit() } } }, icon('power'), 'Quit'))
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
    if (!this.current) return replace(main, emptyState('targets', 'No target selected', 'Add a target first.', el('span', { class: 'row' }, button('Targets', () => this.show('targets'), { class: 'primary' }))))
    if (screen === 'status') return replace(main, renderStatus(this))
    if (screen === 'plan') return replace(main, renderPlan(this))
    if (screen === 'history') return replace(main, renderHistory(this))
    replace(main, this.run ? this.run.element : el('section', { aria: { label: 'Run' } },
      emptyState('run', 'Nothing running here', 'No run in this tab yet: start one from Plan & deploy, or attach from Status.')))
  }

  /** Re-renders the current screen (after a state change). */
  refresh(): void {
    this.show(this.screen)
  }

  renderNav(): void {
    const select = el('select', { id: 'target-select', aria: { label: 'Target' }, on: { change: (event) => { this.select((event.target as HTMLSelectElement).value); this.refresh(); if (this.current) void this.refreshStatus() } } },
      ...this.targets.targets.map((t) => {
        const option = el('option', { value: t.name }, t.name)
        option.selected = t.name === this.current?.name
        return option
      }))
    replace(this.shell.nav,
      this.targets.targets.length > 0 ? el('div', { class: 'nav-target' }, el('label', { class: 'section-label', for: 'target-select' }, 'Target'), select) : null,
      el('div', { class: 'nav-list' }, ...SCREENS.map(([screen, label, name]) => el('button', {
        type: 'button', class: 'nav-item', ...(screen === this.screen ? { aria: { current: 'page' } } : {}),
        on: { click: () => this.show(screen) },
      }, icon(name), label))))
  }

  /**
   * "Am I about to deploy production?": name, destination, the server's host
   * name and the app — on every screen. The dividers are text (" · ") for
   * screen readers and copy, drawn as rules.
   */
  renderBar(): void {
    const t = this.current
    if (!t) return this.clearBar()
    const status = this.status
    const sep = () => el('span', { class: 'ctx-sep', aria: { hidden: 'true' } }, ' · ')
    const item = (name: IconName, value: string, label?: string): Child[] => [sep(),
      el('span', { class: 'ctx-item' }, icon(name), label ? el('span', { class: 'ctx-label' }, label) : null, label ? ' ' : null, el('span', { class: 'ctx-val' }, value))]
    this.shell.bar.classList.toggle('is-protected', t.protected === true)
    replace(this.shell.bar,
      el('span', { class: 'ctx-target' }, el('strong', { class: 'ctx-name' }, t.name),
        t.protected ? el('span', { class: 'badge badge-protected', title: 'Deploy and rollback ask for the name to be typed' }, icon('shield'), quiet(' '), 'PROTECTED') : null),
      ...item('terminal', `${t.ssh}${t.port ? `:${t.port}` : ''}`),
      ...item('folder', t.dir),
      ...(this.hello ? [...item('server', this.hello.host, 'host'), ...item('tag', this.hello.version, 'deploy')] : []),
      ...(status ? item('app', status.app, 'app') : []))
  }

  private clearBar(): void {
    this.shell.bar.classList.remove('is-protected')
    replace(this.shell.bar)
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

  /** The commits between two releases of the current target (read-only on the server). */
  commits(from: string, to: string): Promise<CommandReply> {
    const t = this.current as TargetView
    const key = `${t.name}\u0000${from}\u0000${to}`
    let reply = this.ranges.get(key)
    if (!reply) {
      reply = this.api.post<CommandReply>('commits', { target: t.name, from, to })
      // A failure is not remembered: the next click asks again.
      reply.then((r) => { if (!r.ok) this.ranges.delete(key) }, () => this.ranges.delete(key))
      this.ranges.set(key, reply)
    }
    return reply
  }

  /** What a rollback would take out of production, now (never cached: the releases move). */
  rollbackPreview(to?: string): Promise<CommandReply> {
    const t = this.current as TargetView
    return this.api.post<CommandReply>('commits', { target: t.name, rollback: true, ...(to ? { to } : {}) })
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
    forgetSession(this.storage)
    replace(this.shell.main, el('div', { class: 'stopped' }, emptyState('power', 'Stopped', 'The deploy UI has stopped. You can close this tab.', 'Detached runs go on on the server; start basalt-deploy-ui again to re-attach.')))
    replace(this.shell.nav)
    this.clearBar()
    replace(this.shell.session)
  }
}
