import type { App } from './app.js'
import { ApiError } from './api.js'
import { confirmDialog } from './dialog.js'
import { button, el, replace } from './dom.js'
import type { CommandReply, TargetsReply, TargetView } from './messages.js'
import { banner, describe, problem } from './reply.js'

const FIELDS: Array<{ key: keyof TargetView; label: string; help: string; type?: 'number' | 'checkbox' }> = [
  { key: 'name', label: 'Name', help: 'lowercase letters, digits and -, e.g. staging' },
  { key: 'ssh', label: 'SSH destination', help: '[user@]host, or a Host alias from your ~/.ssh/config (jump hosts and keys go there)' },
  { key: 'port', label: 'Port', help: 'optional; default: your ~/.ssh/config, else 22', type: 'number' },
  { key: 'dir', label: 'Checkout on the server', help: 'absolute path, e.g. /srv/myapp' },
  { key: 'node', label: 'node on the server', help: 'optional absolute path, when a non-interactive shell has no node on PATH' },
  { key: 'config', label: 'Config file', help: 'optional, relative to the checkout (default deploy.config.ts)' },
  { key: 'protected', label: 'Protected: type the name to deploy or roll back', help: '', type: 'checkbox' },
]

/** Targets: list, add/edit/remove, check the connection. */
export function renderTargets(app: App): HTMLElement {
  const root = el('section', { aria: { labelledby: 'targets-title' } })
  const checkArea = el('div', { aria: { live: 'polite' } })
  const formArea = el('div')
  const t = app.targets

  const list = t.targets.length === 0
    ? el('p', {}, 'No target yet. Add the server you already reach with ssh as the app user.')
    : el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Name'), el('th', {}, 'SSH'), el('th', {}, 'Checkout'), el('th', {}, ''), el('th', {}, 'Actions'))),
      el('tbody', {}, ...t.targets.map((target) => el('tr', {},
        el('td', {}, target.name),
        el('td', { class: 'mono' }, `${target.ssh}${target.port ? ` -p ${target.port}` : ''}`),
        el('td', { class: 'mono' }, target.dir),
        el('td', {}, target.protected ? 'protected' : ''),
        el('td', {}, el('div', { class: 'row' },
          button('Use', () => { app.select(target.name); app.show('status'); void app.refreshStatus() }),
          button('Check connection', () => { void check(app, target, checkArea) }),
          button('Edit', () => replace(formArea, targetForm(app, target))),
          button('Remove', () => { void remove(app, target) }, { class: 'danger' }),
        )),
      )))))

  replace(root,
    el('h2', { id: 'targets-title' }, 'Targets'),
    el('p', { class: 'muted' }, 'Stored on this machine only, in ', el('code', {}, t.path), ' (0600). They hold no secret.'),
    t.error ? banner('err', t.error) : null,
    list,
    checkArea,
    actorForm(app),
    button('Add a target', () => replace(formArea, targetForm(app, undefined)), { class: 'primary' }),
    formArea,
  )
  if (t.targets.length === 0 && !t.error) replace(formArea, targetForm(app, undefined))
  return root
}

async function check(app: App, target: TargetView, area: HTMLElement): Promise<void> {
  replace(area, el('p', { class: 'muted' }, `Connecting to ${target.ssh}…`))
  let reply: CommandReply
  try {
    reply = await app.api.post<CommandReply>('status', { target: target.name })
  } catch (error) {
    replace(area, problem(undefined, error))
    return
  }
  if (reply.hello?.protocol === 1 && !reply.failure) {
    replace(area, banner('ok', `${target.name} answers: @basaltkit/deploy ${reply.hello.version}, protocol 1, host ${reply.hello.host}`))
    if (app.current?.name === target.name) { app.statusReply = reply; app.hello = reply.hello; app.renderBar() }
    return
  }
  replace(area, problem(reply))
}

async function remove(app: App, target: TargetView): Promise<void> {
  const ok = await confirmDialog({ title: `Remove ${target.name}?`, lines: ['Only this UI forgets it; nothing changes on the server.'], confirmLabel: 'Remove', danger: true })
  if (!ok) return
  try {
    app.targets = await app.api.post<TargetsReply>('targets/remove', { name: target.name })
    await app.loadTargets()
  } catch (error) {
    app.shell.main.prepend(problem(undefined, error) as HTMLElement)
    return
  }
  app.show('targets')
}

function actorForm(app: App): HTMLElement {
  const input = el('input', { type: 'text', id: 'actor', value: app.targets.actor ?? '', autocomplete: 'off', spellcheck: false, aria: { describedby: 'actor-help' } })
  const message = el('span', { id: 'actor-help', class: 'muted' }, 'Recorded with each release as --actor (letters, digits and ._@+-).')
  const form = el('form', { class: 'panel', on: { submit: (event) => {
    event.preventDefault()
    void app.api.post<TargetsReply>('targets/save', { actor: input.value.trim() === '' ? null : input.value.trim() })
      .then((reply) => { app.targets = reply; replace(message, 'Saved.') })
      .catch((error: unknown) => { replace(message, el('span', { class: 'field-error' }, describe(error))) })
  } } },
  el('div', { class: 'field' }, el('label', { for: 'actor' }, 'Your name in the audit (actor)'), input, message),
  el('button', { type: 'submit' }, 'Save actor'))
  return form
}

function targetForm(app: App, existing: TargetView | undefined): HTMLElement {
  const inputs = new Map<keyof TargetView, HTMLInputElement>()
  const errors = new Map<string, HTMLElement>()
  const general = el('div', { aria: { live: 'polite' } })
  const fields = FIELDS.map((field) => {
    const id = `target-${field.key}`
    const value = existing?.[field.key]
    const error = el('span', { id: `${id}-error`, class: 'field-error' })
    errors.set(field.key, error)
    const input = field.type === 'checkbox'
      ? el('input', { type: 'checkbox', id, checked: value === true, aria: { describedby: `${id}-error` } })
      : el('input', { type: field.type === 'number' ? 'number' : 'text', id, value: value === undefined ? '' : String(value), autocomplete: 'off', spellcheck: false, required: field.key === 'name' || field.key === 'ssh' || field.key === 'dir', aria: { describedby: `${id}-help ${id}-error` } })
    inputs.set(field.key, input)
    return el('div', { class: 'field' },
      el('label', { for: id }, field.label, field.key === 'name' || field.key === 'ssh' || field.key === 'dir' ? el('span', { class: 'required' }, ' *') : null),
      input,
      field.help ? el('span', { id: `${id}-help`, class: 'muted' }, field.help) : null,
      error)
  })
  const submit = async (event: Event) => {
    event.preventDefault()
    for (const error of errors.values()) replace(error)
    replace(general)
    const target: Record<string, unknown> = {}
    for (const field of FIELDS) {
      const input = inputs.get(field.key) as HTMLInputElement
      if (field.type === 'checkbox') { if (input.checked) target[field.key] = true; continue }
      const value = input.value.trim()
      if (value === '') continue
      target[field.key] = field.type === 'number' ? Number(value) : value
    }
    try {
      app.targets = await app.api.post<TargetsReply>('targets/save', { target, ...(existing ? { previousName: existing.name } : {}) })
      await app.loadTargets()
      if (!app.current) app.select(String(target['name']))
      app.show('targets')
    } catch (error) {
      const fieldErrors = error instanceof ApiError ? error.body['errors'] as Record<string, string> | undefined : undefined
      if (fieldErrors) {
        for (const [key, message] of Object.entries(fieldErrors)) {
          const slot = errors.get(key)
          if (slot) replace(slot, message)
          else general.append(el('p', { class: 'field-error' }, `${key}: ${message}`))
        }
        ;(inputs.get(Object.keys(fieldErrors)[0] as keyof TargetView) ?? inputs.get('name'))?.focus()
      } else replace(general, problem(undefined, error))
    }
  }
  return el('form', { class: 'panel', aria: { label: existing ? `Edit ${existing.name}` : 'Add a target' }, on: { submit: (event) => { void submit(event) } } },
    el('h3', {}, existing ? `Edit ${existing.name}` : 'Add a target'),
    ...fields,
    general,
    el('div', { class: 'row' }, el('button', { type: 'submit', class: 'primary' }, 'Save'), button('Cancel', () => app.show('targets'))))
}
