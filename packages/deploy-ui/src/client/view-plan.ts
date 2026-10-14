import type { DetachResult, Finding, PromptDescriptor } from '@basaltkit/deploy/protocol'
import type { App } from './app.js'
import { confirmDialog } from './dialog.js'
import { append, button, el, replace, type Child } from './dom.js'
import type { CommandReply } from './messages.js'
import { banner, describe, diagnosticsBlock, problem } from './reply.js'
import { ApiError } from './api.js'

/** Plan & deploy: what a run would do, the questions it would ask, and the `.env` form. */
export function renderPlan(app: App): HTMLElement {
  const reply = app.planReply
  const plan = app.plan
  const root = el('section', { aria: { labelledby: 'plan-title' } },
    el('div', { class: 'row' }, el('h2', { id: 'plan-title' }, 'Plan & deploy'),
      button(app.planBusy ? 'Planning…' : plan ? 'Plan again' : 'Run plan', () => { void app.runPlan() }, { disabled: app.planBusy, class: plan ? '' : 'primary' })),
    el('p', { class: 'muted' }, 'plan changes nothing on the server. Its preflight may reach the git remote, so it can take a while.'))
  if (!reply) return root
  if (!plan) {
    append(root, problem(reply) ?? el('p', {}, 'No plan came back.'))
    return root
  }
  append(root, ...findings(plan.findings))
  if (plan.lines.length > 0) {
    append(root, el('h3', {}, 'What a run would do'), el('div', { class: 'table-wrap' }, el('table', {},
      el('tbody', {}, ...plan.lines.map((line) => el('tr', {}, el('th', { class: 'mono' }, line.step), el('td', {}, line.text)))))))
  }
  if (reply.diagnostics.length > 0) append(root, diagnosticsBlock(reply.diagnostics))
  append(root, deployForm(app, plan.questions, plan.blocking))
  return root
}

function findings(list: Finding[]): Child[] {
  if (list.length === 0) return [banner('ok', 'No problem found.')]
  const sorted = [...list].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
  return [el('h3', {}, 'Findings'), el('ul', {}, ...sorted.map((f) => el('li', {},
    el('strong', { class: f.level === 'error' ? 'status-err' : 'status-warn' }, f.level === 'error' ? 'Error ' : 'Warning '),
    el('span', { class: 'muted' }, `[${f.id}] `), f.message,
    f.fix ? el('div', {}, 'Fix: ', el('code', {}, f.fix)) : null)))]
}

interface Field {
  question: PromptDescriptor
  input: HTMLInputElement | HTMLSelectElement
}

function questionField(question: PromptDescriptor, index: number): { node: HTMLElement; field: Field } {
  const id = `q-${index}`
  const label = el('label', { for: id }, question.message, question.key ? el('span', { class: 'muted' }, ` (${question.key})`) : null, question.optional ? '' : el('span', { class: 'required' }, ' *'))
  let input: HTMLInputElement | HTMLSelectElement
  if (question.kind === 'secret') {
    // No default, no autocomplete, no spellcheck: a secret is typed, sent once, and the field is emptied.
    input = el('input', { type: 'password', id, autocomplete: 'off', spellcheck: false, required: !question.optional, aria: { describedby: `${id}-error` } })
  } else if (question.kind === 'choice') {
    input = el('select', { id, aria: { describedby: `${id}-error` } }, ...(question.optional ? [el('option', { value: '' }, '(none)')] : []), ...(question.choices ?? []).map((c) => el('option', { value: c }, c)))
    if (question.default !== undefined) input.value = question.default
  } else if (question.kind === 'confirm') {
    input = el('input', { type: 'checkbox', id, checked: question.default === 'yes' || question.default === 'true', aria: { describedby: `${id}-error` } })
  } else {
    input = el('input', { type: 'text', id, value: question.default ?? '', autocomplete: 'off', spellcheck: false, required: !question.optional, aria: { describedby: `${id}-error` } })
  }
  return { node: el('div', { class: 'field' }, label, input, el('span', { id: `${id}-error`, class: 'field-error' })), field: { question, input } }
}

/** The answers the operator typed: empty optional fields are left out (the deploy keeps its default or nothing). */
function collectAnswers(fields: Field[]): Array<{ id: string; value: string }> {
  const answers: Array<{ id: string; value: string }> = []
  for (const { question, input } of fields) {
    const value = question.kind === 'confirm' ? ((input as HTMLInputElement).checked ? 'yes' : 'no') : input.value
    if (value === '' && question.optional) continue
    answers.push({ id: question.id, value })
  }
  return answers
}

/** Every field emptied, so no value lingers in the page after it was sent. */
function clearFields(fields: Field[]): void {
  for (const { input } of fields) {
    if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = false
    else input.value = ''
  }
}

function deployForm(app: App, questions: PromptDescriptor[], blocking: boolean): HTMLElement {
  const t = app.current
  const fields: Field[] = []
  const nodes = questions.map((q, i) => {
    const { node, field } = questionField(q, i)
    fields.push(field)
    return node
  })
  const message = el('div', { aria: { live: 'polite' } })
  const hold = app.status?.hold
  const unhold = el('input', { type: 'checkbox', id: 'unhold' })
  const attended = el('input', { type: 'checkbox', id: 'attended' })

  const showFieldError = (id: string, text: string) => {
    const index = questions.findIndex((q) => q.id === id)
    const slot = index === -1 ? undefined : app.shell.main.querySelector(`#q-${index}-error`)
    if (slot) replace(slot, text)
  }

  const send = async (route: 'run' | 'env') => {
    if (!t) return
    replace(message)
    for (let i = 0; i < questions.length; i++) {
      const slot = app.shell.main.querySelector(`#q-${i}-error`)
      if (slot) replace(slot)
    }
    const deploy = route === 'run'
    const ok = await confirmDialog({
      title: deploy ? `Deploy to ${t.name}?` : `Write the .env on ${t.name}?`,
      lines: [
        `${t.ssh} · ${t.dir}${app.hello ? ` · host ${app.hello.host}` : ''}${app.status ? ` · app ${app.status.app}` : ''}`,
        deploy ? 'Fetch, .env, build, migrate, restart, health check — the run goes on on the server if this page closes (unless attended).' : 'The .env and the dedicated infra only; nothing is built or restarted.',
        deploy && app.plan?.lines.some((l) => /migrat/i.test(l.step) || /migrat/i.test(l.text)) ? el('strong', {}, 'This will migrate the database.') : null,
      ],
      confirmLabel: deploy ? 'Deploy' : 'Write .env',
      danger: true,
      ...(t.protected ? { typeToConfirm: t.name } : {}),
    })
    if (!ok) return
    const answers = collectAnswers(fields)
    clearFields(fields)
    const body: Record<string, unknown> = { target: t.name, confirm: true, confirmedTarget: t, answers, ...(t.protected ? { confirmName: t.name } : {}) }
    if (!deploy) {
      app.attended(`env on ${t.name}`, 'env', body)
      return
    }
    if (unhold.checked) body['unhold'] = true
    if (attended.checked) {
      body['attended'] = true
      app.attended(`run on ${t.name} (attended)`, 'run', body)
      return
    }
    replace(message, el('p', { class: 'muted' }, 'Starting the run on the server…'))
    let reply: CommandReply
    try {
      reply = await app.api.post<CommandReply>('run', body)
    } catch (error) {
      const field = error instanceof ApiError && typeof error.body['field'] === 'string' ? error.body['field'] : undefined
      if (field) showFieldError(field, describe(error))
      replace(message, problem(undefined, error))
      void app.noticeChange(error)
      return
    }
    const result = reply.result as DetachResult | undefined
    if (reply.ok && result?.runId) {
      replace(message)
      app.watch(result.runId, `run ${result.runId}`)
      return
    }
    if (reply.error && /^answer-/.test(reply.error.code)) {
      const id = /env\.[A-Z_][A-Z0-9_]*/.exec(reply.error.message)?.[0]
      if (id) showFieldError(id, `${reply.error.message} — type it again`)
    }
    replace(message, problem(reply))
  }

  return el('form', { class: 'panel', aria: { label: 'Deploy' }, on: { submit: (event) => { event.preventDefault(); void send('run') } } },
    el('h3', {}, questions.length > 0 ? 'What the run will ask' : 'Deploy'),
    questions.length > 0 ? el('p', { class: 'muted' }, 'Secrets are sent once, over your ssh, to the deploy on the server; they are never stored here and the fields are emptied after sending.') : el('p', { class: 'muted' }, 'Nothing to answer: the .env is complete.'),
    ...nodes,
    hold ? el('div', { class: 'field' }, el('label', { for: 'unhold' }, unhold, ' Deploy anyway: the held commit ', el('code', {}, hold.sha.slice(0, 12)), ' may be deployed (--unhold)')) : null,
    el('details', {}, el('summary', {}, 'Advanced'),
      el('div', { class: 'field' }, el('label', { for: 'attended' }, attended, ' Attended: the run stops at its next step if this page closes or the UI quits'))),
    blocking ? banner('err', 'The plan found problems that stop a run: fix them first.') : null,
    el('div', { class: 'row' },
      el('button', { type: 'submit', class: 'primary', disabled: blocking }, 'Deploy…'),
      button('Write .env only…', () => { void send('env') })),
    message)
}
