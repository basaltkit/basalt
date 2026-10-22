import { append, button, el, type Child } from './dom.js'
import { t } from './i18n.js'
import { icon } from './icons.js'

export interface ConfirmOptions {
  title: string
  lines: Child[]
  confirmLabel: string
  /** Where the action lands (target, destination, host, app), shown as an identifier above the lines. */
  context?: string
  danger?: boolean
  /** The operator must type this (a protected target's name) before confirming. */
  typeToConfirm?: string
}

/**
 * A native modal `<dialog>` (focus stays inside, Escape cancels). Resolves
 * true only on the confirm button.
 */
export function confirmDialog(options: ConfirmOptions, host: HTMLElement = document.body): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: options.danger ? 'is-danger' : '', aria: { labelledby: 'confirm-title' } })
    let settled = false
    const finish = (answer: boolean) => {
      if (settled) return
      settled = true
      if (typeof dialog.close === 'function' && dialog.open) dialog.close()
      dialog.remove()
      resolve(answer)
    }
    const confirm = button(options.confirmLabel, () => finish(true), { class: options.danger ? 'danger' : 'primary' })
    const dismiss = button(t('cancel'), () => finish(false))
    let typed: HTMLInputElement | undefined
    if (options.typeToConfirm !== undefined) {
      const expected = options.typeToConfirm
      confirm.disabled = true
      typed = el('input', {
        type: 'text', id: 'confirm-name', autocomplete: 'off', spellcheck: false,
        on: { input: () => { confirm.disabled = (typed as HTMLInputElement).value !== expected } },
      })
    }
    append(dialog,
      el('div', { class: 'dialog-head' }, el('span', { class: 'dialog-icon' }, icon(options.danger ? 'alert' : 'info')), el('h2', { id: 'confirm-title' }, options.title)),
      el('div', { class: 'dialog-body' },
        options.context ? el('p', { class: 'dialog-context' }, options.context) : null,
        options.typeToConfirm !== undefined ? el('p', { class: 'dialog-protected' }, el('span', { class: 'badge badge-protected' }, icon('shield'), t('protected.badge')), t('dialog.protected')) : null,
        ...options.lines.filter((line) => line !== null && line !== undefined && line !== false && line !== '').map((line) => el('p', {}, line)),
        typed ? el('div', { class: 'field' }, el('label', { for: 'confirm-name' }, t('dialog.typeTo'), el('code', {}, options.typeToConfirm as string), t('dialog.toConfirm')), typed) : null),
      el('div', { class: 'dialog-actions' }, dismiss, confirm),
    )
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false) })
    dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') finish(false) })
    host.appendChild(dialog)
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal()
      } catch {
        dialog.setAttribute('open', '')
      }
    } else dialog.setAttribute('open', '')
    // A destructive action never starts with focus on its own button: one
    // Enter too many (or a held key) must not confirm it.
    ;(typed ?? (options.danger ? dismiss : confirm)).focus()
  })
}
