import type { DetachResult, Finding, PromptDescriptor } from '@basaltkit/deploy/protocol'
import type { App } from './app.js'
import { confirmDialog } from './dialog.js'
import { append, button, card, el, emptyState, pageHead, replace, type Child } from './dom.js'
import { icon } from './icons.js'
import type { CommandReply } from './messages.js'
import { banner, describe, diagnosticsBlock, problem } from './reply.js'
import { ApiError } from './api.js'
import { commitsBlock, rangeSpan, validCommits } from './view-commits.js'

/** Plan & deploy: what a run would do, the questions it would ask, and the `.env` form. */
export function renderPlan(app: App): HTMLElement {
  const reply = app.planReply
  const plan = app.plan
  const root = el('section', { aria: { labelledby: 'plan-title' } },
    pageHead('plan-title', 'Plan & deploy', 'plan changes nothing on the server. Its preflight may reach the git remote, so it can take a while.',
      button(app.planBusy ? 'Planning…' : plan ? 'Plan again' : 'Run plan', () => { void app.runPlan() }, { disabled: app.planBusy, class: plan ? '' : 'primary' })))
  if (!reply) {
    append(root, app.planBusy
      ? emptyState('refresh', 'Planning…', 'Preflight checks and the plan run on the server; nothing changes there.')
      : emptyState('plan', 'No plan yet', 'Run a plan to see what a deploy would do, the questions it would ask, and anything that would stop it.'))
    return root
  }
  if (!plan) {
    append(root, problem(reply) ?? el('p', {}, 'No plan came back.'))
    return root
  }
  append(root, ...findings(plan.findings))
  append(root, outgoing(plan.commits))
  if (plan.lines.length > 0) {
    append(root, card('What a run would do', [el('div', { class: 'table-wrap' }, el('table', { class: 'plan-lines' },
      el('tbody', {}, ...plan.lines.map((line) => el('tr', {}, el('th', { scope: 'row' }, el('span', { class: 'step-chip' }, line.step)), el('td', {}, line.text))))))],
    { bodyClass: 'flush' }))
  }
  if (reply.diagnostics.length > 0) append(root, diagnosticsBlock(reply.diagnostics))
  append(root, deployForm(app, plan.questions, plan.blocking))
  return root
}

/** What a run would deploy: HEAD on the server to the branch's tip on its remote. */
function outgoing(commits: unknown): HTMLElement {
  const range = validCommits(commits) && commits.ok ? commits.range : undefined
  const summary = !range ? null
    : range.relation === 'ahead' ? `${range.addedTotal} commit${range.addedTotal === 1 ? '' : 's'}`
    : range.relation === 'diverged' ? `${range.addedTotal} new · ${range.removedTotal} only on the server`
    : range.relation === 'behind' ? `${range.removedTotal} behind`
    : null
  return card('What will go out', [
    range?.relation === 'diverged' ? banner('warn', 'The branch was rewritten on the remote', ['A run refuses it: its merge is fast-forward only. The commits only on the server would be lost.']) : null,
    range?.relation === 'behind' ? banner('warn', 'The remote\'s branch is behind the server', ['A run refuses it: its merge is fast-forward only.']) : null,
    range?.held ? banner('warn', 'This commit is held by a rollback', ['A run refuses it unless you deploy anyway (--unhold).']) : null,
    commitsBlock(commits, { added: 'Goes out', removed: 'Only on the server', same: 'Nothing new — the server already runs the tip of the branch.' }),
  ], { actions: range && range.relation !== 'same' ? [summary ? el('span', { class: 'muted' }, summary) : null, rangeSpan(range)] : [] })
}

function findings(list: Finding[]): Child[] {
  if (list.length === 0) return [banner('ok', 'No problem found.')]
  const sorted = [...list].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
  const errors = list.filter((f) => f.level === 'error').length
  return [card('Findings', [findingList(sorted)], {
    bodyClass: 'flush',
    actions: [el('span', { class: 'muted' }, `${errors} error${errors === 1 ? '' : 's'}, ${list.length - errors} warning${list.length - errors === 1 ? '' : 's'}`)],
  })]
}

/** Findings with a severity badge; the fix is copyable text, never run by the page. */
export function findingList(list: Array<Pick<Finding, 'level' | 'message' | 'fix'> & { id?: string }>, label?: string): HTMLElement {
  return el('ul', { class: 'findings', ...(label ? { aria: { label } } : {}) }, ...list.map((f) => findingItem(f)))
}

export function findingItem(f: Pick<Finding, 'level' | 'message' | 'fix'> & { id?: string }): HTMLElement {
  return el('li', { class: 'finding' },
    el('span', { class: `sev sev-${f.level === 'error' ? 'error' : 'warning'}` }, f.level === 'error' ? 'Error ' : 'Warning '),
    el('span', { class: 'finding-msg' }, f.id ? el('span', { class: 'finding-id' }, `[${f.id}] `) : null, f.message),
    f.fix ? el('div', { class: 'fix' }, el('span', { class: 'fix-label' }, 'Fix: '), el('code', {}, f.fix)) : null)
}

interface Field {
  question: PromptDescriptor
  input: HTMLInputElement | HTMLSelectElement
}

function questionField(question: PromptDescriptor, index: number): { node: HTMLElement; field: Field } {
  const id = `q-${index}`
  const label = el('label', { for: id }, question.message, question.optional ? '' : el('span', { class: 'required', title: 'required' }, ' *'), question.key ? el('span', { class: 'field-key' }, ` (${question.key})`) : null)
  let input: HTMLInputElement | HTMLSelectElement
  if (question.kind === 'secret') {
    // No default, no autocomplete, no spellcheck: a secret is typed, sent once, and the field is emptied.
    input = el('input', { type: 'password', id, autocomplete: 'off', spellcheck: false, required: !question.optional, aria: { describedby: `${id}-error` } })
  } else if (question.kind === 'choice') {
    input = el('select', { id, aria: { describedby: `${id}-error` } }, ...(question.optional ? [el('option', { value: '' }, '(none)')] : []), ...(question.choices ?? []).map((c) => el('option', { value: c }, c)))
    if (question.default !== undefined) input.value = question.default
  } else if (question.kind === 'confirm') {
    input = el('input', { type: 'checkbox', id, checked: question.default === 'yes' || question.default === 'true', aria: { describedby: `${id}-error` } })
    return { node: el('div', { class: 'field check' }, el('label', { for: id }, input, el('span', {}, question.message, question.optional ? '' : el('span', { class: 'required', title: 'required' }, ' *'), question.key ? el('span', { class: 'field-key' }, ` (${question.key})`) : null)), el('span', { id: `${id}-error`, class: 'field-error' })), field: { question, input } }
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
      context: `${t.ssh} · ${t.dir}${app.hello ? ` · host ${app.hello.host}` : ''}${app.status ? ` · app ${app.status.app}` : ''}`,
      lines: [
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

  return el('form', { class: 'card', aria: { label: 'Deploy' }, on: { submit: (event) => { event.preventDefault(); void send('run') } } },
    el('div', { class: 'card-head' }, el('h3', {}, questions.length > 0 ? 'What the run will ask' : 'Deploy'),
      t?.protected ? el('span', { class: 'badge badge-protected' }, icon('shield'), 'PROTECTED') : null),
    el('div', { class: 'card-body' },
      el('p', { class: 'form-note' }, icon(questions.length > 0 ? 'lock' : 'ok'), questions.length > 0 ? 'Secrets are sent once, over your ssh, to the deploy on the server; they are never stored here and the fields are emptied after sending.' : 'Nothing to answer: the .env is complete.'),
      nodes.length > 0 ? el('div', { class: 'form-section' }, ...nodes) : null,
      el('div', { class: 'form-section' },
        hold ? el('div', { class: 'field check' }, el('label', { for: 'unhold' }, unhold, el('span', {}, ' Deploy anyway: the held commit ', el('code', {}, hold.sha.slice(0, 12)), ' may be deployed (--unhold)'))) : null,
        el('details', { class: 'advanced' }, el('summary', {}, 'Advanced'),
          el('div', { class: 'field check' }, el('label', { for: 'attended' }, attended, el('span', {}, ' Attended: the run stops at its next step if this page closes or the UI quits'))))),
      blocking ? banner('err', 'The plan found problems that stop a run: fix them first.') : null,
      message),
    el('div', { class: 'card-foot' },
      button('Write .env only…', () => { void send('env') }),
      el('button', { type: 'submit', class: 'primary', disabled: blocking }, 'Deploy…')))
}
