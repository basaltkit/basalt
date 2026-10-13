import { clean } from './sanitize.js'

/**
 * The page's only way to build DOM: elements, properties and text nodes.
 * Strings become text nodes (cleaned first); there is no HTML parsing path.
 */

export type Child = Node | string | number | false | null | undefined

export interface Props {
  class?: string
  id?: string
  type?: string
  name?: string
  value?: string
  placeholder?: string
  title?: string
  disabled?: boolean
  checked?: boolean
  required?: boolean
  hidden?: boolean
  for?: string
  autocomplete?: string
  spellcheck?: boolean
  role?: string
  min?: string
  max?: string
  aria?: Record<string, string>
  on?: Partial<Record<'click' | 'submit' | 'input' | 'change', (event: Event) => void>>
}

export function text(value: unknown): Text {
  return document.createTextNode(clean(value))
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (props.class) node.className = props.class
  if (props.id) node.id = props.id
  for (const key of ['type', 'name', 'placeholder', 'title', 'role', 'autocomplete', 'min', 'max', 'for'] as const) {
    const value = props[key]
    if (value !== undefined) node.setAttribute(key, value)
  }
  if (props.value !== undefined) (node as HTMLInputElement).value = props.value
  if (props.disabled) (node as HTMLButtonElement).disabled = true
  if (props.checked) (node as HTMLInputElement).checked = true
  if (props.required) (node as HTMLInputElement).required = true
  if (props.hidden) node.hidden = true
  if (props.spellcheck !== undefined) node.spellcheck = props.spellcheck
  for (const [key, value] of Object.entries(props.aria ?? {})) node.setAttribute(`aria-${key}`, value)
  for (const [event, listener] of Object.entries(props.on ?? {})) node.addEventListener(event, listener as EventListener)
  append(node, ...children)
  return node
}

export function append(node: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === false || child === null || child === undefined) continue
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? text(child) : child)
  }
}

export function replace(node: Node, ...children: Child[]): void {
  while (node.firstChild) node.removeChild(node.firstChild)
  append(node, ...children)
}

export function button(label: string, onClick: () => void, props: Props = {}): HTMLButtonElement {
  return el('button', { type: 'button', ...props, on: { click: () => onClick() } }, label)
}

/** A short when: the ISO time as the server wrote it, without milliseconds. */
export const when = (iso: unknown) => clean(iso).replace('T', ' ').replace(/\.\d+Z$/, 'Z')
