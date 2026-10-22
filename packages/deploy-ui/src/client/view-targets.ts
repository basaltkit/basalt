import type { App } from './app.js'
import { ApiError } from './api.js'
import { confirmDialog } from './dialog.js'
import { button, card, el, emptyState, pageHead, replace } from './dom.js'
import { serverText, t, type MessageKey } from './i18n.js'
import { icon } from './icons.js'
import type { CommandReply, TargetsReply, TargetView } from './messages.js'
import { banner, describe, problem } from './reply.js'
import { driftBanner, sourceText, validSource } from './version.js'

const FIELDS: Array<{ key: keyof TargetView; label: MessageKey; help?: MessageKey; type?: 'number' | 'checkbox' }> = [
  { key: 'name', label: 'field.name', help: 'field.name.help' },
  { key: 'ssh', label: 'field.ssh', help: 'field.ssh.help' },
  { key: 'port', label: 'field.port', help: 'field.port.help', type: 'number' },
  { key: 'dir', label: 'field.dir', help: 'field.dir.help' },
  { key: 'node', label: 'field.node', help: 'field.node.help' },
  { key: 'config', label: 'field.config', help: 'field.config.help' },
  { key: 'protected', label: 'field.protected', type: 'checkbox' },
]

/** Targets: list, add/edit/remove, check the connection. */
export function renderTargets(app: App): HTMLElement {
  const root = el('section', { aria: { labelledby: 'targets-title' } })
  const checkArea = el('div', { aria: { live: 'polite' } })
  const formArea = el('div')
  const file = app.targets

  const list = file.targets.length === 0
    ? emptyState('targets', t('targets.none'), t('targets.noneText'))
    : card(t('targets.servers'), [el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, t('field.name')), el('th', { scope: 'col' }, t('targets.ssh')), el('th', { scope: 'col' }, t('targets.checkout')), el('th', { scope: 'col' }, el('span', { class: 'sr-only' }, t('targets.protection'))), el('th', { scope: 'col', class: 'num' }, t('targets.actions')))),
      el('tbody', {}, ...file.targets.map((target) => el('tr', {},
        el('td', { class: 'target-name' }, target.name),
        el('td', { class: 'mono' }, `${target.ssh}${target.port ? ` -p ${target.port}` : ''}`),
        el('td', { class: 'mono' }, target.dir),
        el('td', {}, target.protected ? el('span', { class: 'badge badge-protected' }, icon('shield'), t('targets.protected')) : ''),
        el('td', { class: 'num' }, el('div', { class: 'row' },
          button(t('targets.use'), () => { app.select(target.name); app.show('status'); void app.refreshStatus() }, { class: target.name === app.current?.name ? 'sm ghost' : 'sm' }),
          button(t('targets.check'), () => { void check(app, target, checkArea) }, { class: 'sm' }),
          button(t('targets.edit'), () => replace(formArea, targetForm(app, target)), { class: 'sm ghost' }),
          button(t('targets.remove'), () => { void remove(app, target) }, { class: 'sm ghost danger' }),
        )),
      )))))], { bodyClass: 'flush', actions: [el('span', { class: 'muted num' }, t('targets.count', { count: file.targets.length }))] })

  replace(root,
    pageHead('targets-title', t('screen.targets'), [t('targets.storedIn'), el('code', {}, file.path), t('targets.storedTail')],
      el('button', { type: 'button', class: 'primary', on: { click: () => replace(formArea, targetForm(app, undefined)) } }, t('targets.add'))),
    file.error ? banner('err', file.error) : null,
    list,
    checkArea,
    formArea,
    actorForm(app),
  )
  if (file.targets.length === 0 && !file.error) replace(formArea, targetForm(app, undefined))
  return root
}

async function check(app: App, target: TargetView, area: HTMLElement): Promise<void> {
  replace(area, el('p', { class: 'muted' }, t('targets.connecting', { ssh: target.ssh })))
  let reply: CommandReply
  try {
    reply = await app.api.post<CommandReply>('status', { target: target.name })
  } catch (error) {
    replace(area, problem(undefined, error))
    return
  }
  if (reply.hello?.protocol === 1 && !reply.failure) {
    const result = reply.result as { app?: unknown; source?: unknown } | undefined
    const source = validSource(result?.source)
    const identity = typeof result?.app !== 'string' ? '' : source ? t('targets.identity', { app: result.app, source: sourceText(source) }) : t('targets.app', { app: result.app })
    replace(area, banner('ok', t('targets.answers', { name: target.name, version: reply.hello.version, host: reply.hello.host }), [identity]), driftBanner(reply.hello.version))
    if (app.current?.name === target.name) { app.statusReply = reply; app.hello = reply.hello; app.renderBar() }
    return
  }
  replace(area, problem(reply))
}

async function remove(app: App, target: TargetView): Promise<void> {
  const ok = await confirmDialog({ title: t('targets.removeTitle', { name: target.name }), lines: [t('targets.removeLine')], confirmLabel: t('targets.remove'), danger: true })
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
  const message = el('span', { id: 'actor-help', class: 'muted' }, t('targets.actorHelp'))
  const form = el('form', { class: 'card', aria: { label: t('targets.auditActor') }, on: { submit: (event) => {
    event.preventDefault()
    void app.api.post<TargetsReply>('targets/save', { actor: input.value.trim() === '' ? null : input.value.trim() })
      .then((reply) => { app.targets = reply; replace(message, t('targets.saved')) })
      .catch((error: unknown) => { replace(message, el('span', { class: 'field-error' }, describe(error))) })
  } } },
  el('div', { class: 'card-head' }, el('h3', {}, t('targets.audit'))),
  el('div', { class: 'card-body' }, el('div', { class: 'field' }, el('label', { for: 'actor' }, t('targets.actorLabel')), input, message)),
  el('div', { class: 'card-foot' }, el('button', { type: 'submit' }, t('targets.saveActor'))))
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
    if (field.type === 'checkbox') {
      return el('div', { class: 'field check span-2' }, el('label', { for: id }, input, el('span', {}, t(field.label))), error)
    }
    return el('div', { class: 'field' },
      el('label', { for: id }, t(field.label), field.key === 'name' || field.key === 'ssh' || field.key === 'dir' ? el('span', { class: 'required' }, ' *') : null),
      input,
      field.help ? el('span', { id: `${id}-help`, class: 'field-help' }, t(field.help)) : null,
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
          if (slot) replace(slot, serverText(message))
          else general.append(el('p', { class: 'field-error' }, `${key}: ${serverText(message)}`))
        }
        ;(inputs.get(Object.keys(fieldErrors)[0] as keyof TargetView) ?? inputs.get('name'))?.focus()
      } else replace(general, problem(undefined, error))
    }
  }
  return el('form', { class: 'card', aria: { label: existing ? t('targets.editTitle', { name: existing.name }) : t('targets.add') }, on: { submit: (event) => { void submit(event) } } },
    el('div', { class: 'card-head' }, el('h3', {}, existing ? t('targets.editTitle', { name: existing.name }) : t('targets.add'))),
    el('div', { class: 'card-body' }, el('div', { class: 'form-grid' }, ...fields), general),
    el('div', { class: 'card-foot' }, button(t('cancel'), () => app.show('targets')), el('button', { type: 'submit', class: 'primary' }, t('save'))))
}
