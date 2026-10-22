import { icon, type IconName } from './icons.js'
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
  scope?: string
  colspan?: number
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
  for (const key of ['type', 'name', 'placeholder', 'title', 'role', 'autocomplete', 'min', 'max', 'for', 'scope'] as const) {
    const value = props[key]
    if (value !== undefined) node.setAttribute(key, value)
  }
  if (props.value !== undefined) (node as HTMLInputElement).value = props.value
  if (props.disabled) (node as HTMLButtonElement).disabled = true
  if (props.checked) (node as HTMLInputElement).checked = true
  if (props.required) (node as HTMLInputElement).required = true
  if (props.hidden) node.hidden = true
  if (props.colspan !== undefined) node.setAttribute('colspan', String(props.colspan))
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

/* The page's components: plain elements and classes from app.css. */

export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'run' | 'skip'

/** A status pill: a dot and a label (the label carries the meaning, never the colour alone). */
export function pill(tone: Tone, label: string): HTMLElement {
  return el('span', { class: `pill pill-${tone}` }, el('span', { class: 'dot', aria: { hidden: 'true' } }), label)
}

/** Text that screen readers and `textContent` keep, but the layout replaces with spacing or a divider. */
export function quiet(value: string): HTMLElement {
  return el('span', { class: 'sr-only' }, value)
}

/** The screen's header: its title (the id a section is labelled by), an optional line under it, and its actions. */
export function pageHead(id: string, title: string, sub: Child | Child[], ...actions: Child[]): HTMLElement {
  const subs = Array.isArray(sub) ? sub : [sub]
  return el('header', { class: 'page-head' },
    el('div', { class: 'page-title' }, el('h2', { id }, title), subs.some((s) => s !== null && s !== undefined && s !== false && s !== '') ? el('p', { class: 'page-sub' }, ...subs) : null),
    actions.some(Boolean) ? el('div', { class: 'page-actions' }, ...actions) : null)
}

/** A card: a header row (title, then actions) and a body. */
export function card(title: string, body: Child[], options: { actions?: Child[]; class?: string; bodyClass?: string; foot?: Child[] } = {}): HTMLElement {
  return el('div', { class: `card${options.class ? ` ${options.class}` : ''}` },
    el('div', { class: 'card-head' }, el('h3', {}, title), options.actions && options.actions.some(Boolean) ? el('div', { class: 'card-actions' }, ...options.actions) : null),
    el('div', { class: `card-body${options.bodyClass ? ` ${options.bodyClass}` : ''}` }, ...body),
    options.foot && options.foot.some(Boolean) ? el('div', { class: 'card-foot' }, ...options.foot) : null)
}

/** A key/value grid. */
export function kv(rows: Array<[string, Child] | null | false>): HTMLElement {
  const list = el('dl', { class: 'kv' })
  for (const row of rows) {
    if (!row) continue
    append(list, el('div', { class: 'kv-row' }, el('dt', {}, row[0]), el('dd', {}, row[1])))
  }
  return list
}

/** An empty or final state: an icon, a title and a line. */
export function emptyState(name: IconName, title: string, ...lines: Child[]): HTMLElement {
  return el('div', { class: 'empty' }, el('div', { class: 'empty-icon' }, icon(name)), el('p', { class: 'empty-title' }, title), ...lines.map((line) => el('p', { class: 'empty-text' }, line)))
}
