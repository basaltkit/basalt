import { append, button, el, type Child } from './dom.js'

export interface ConfirmOptions {
  title: string
  lines: Child[]
  confirmLabel: string
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
    const dialog = el('dialog', { aria: { labelledby: 'confirm-title' } })
    let settled = false
    const finish = (answer: boolean) => {
      if (settled) return
      settled = true
      if (typeof dialog.close === 'function' && dialog.open) dialog.close()
      dialog.remove()
      resolve(answer)
    }
    const confirm = button(options.confirmLabel, () => finish(true), { class: options.danger ? 'danger' : 'primary' })
    const dismiss = button('Cancel', () => finish(false))
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
      el('h2', { id: 'confirm-title' }, options.title),
      ...options.lines.map((line) => el('p', {}, line)),
      typed ? el('div', { class: 'field' }, el('label', { for: 'confirm-name' }, `Type ${options.typeToConfirm} to confirm`), typed) : null,
      el('div', { class: 'row' }, dismiss, confirm),
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
