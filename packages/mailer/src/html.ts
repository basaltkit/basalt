/**
 * HTML-safe mail templating (review 2026-08-b, S-4).
 *
 * Mail bodies are HTML rendered from schema data that is usually
 * USER-CONTROLLED (names, titles, comments). Interpolating it bare hands an
 * attacker markup inside mail sent from your own DKIM/SPF-aligned domain —
 * phishing content, tracking pixels, XSS in permissive webmail clients.
 *
 * The safe path is the default path: write bodies with the {@link html}
 * tagged template and every interpolation is escaped automatically —
 * remembering to escape is not required, forgetting is not possible:
 *
 *     html: ({ name }) => html`<h1>Hello ${name}</h1>`
 *
 * Deliberate markup goes through {@link raw} (trusted fragments only), and
 * {@link escapeHtml} is exported for manual composition.
 */

const ESCAPED = /[&<>"']/g

/** Escape `& < > " '` for safe interpolation into HTML text or attributes. */
export function escapeHtml(value: string): string {
  return value.replace(ESCAPED, (c) => `&#${c.charCodeAt(0)};`)
}

/**
 * A fragment of already-safe HTML. Produced by {@link html} and {@link raw};
 * {@link html} interpolates it verbatim, so nested templates compose without
 * double-escaping. Stringifies to its markup, so it drops straight into a mail
 * definition's `html` field.
 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

/**
 * Marks a string as trusted HTML so {@link html} interpolates it verbatim.
 * Only use it on markup you built yourself — never on user input.
 */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value)
}

const render = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (value instanceof SafeHtml) return value.value // already safe — compose, don't re-escape
  if (Array.isArray(value)) return value.map(render).join('')
  return escapeHtml(String(value))
}

/**
 * Tagged template that escapes every interpolation (arrays are rendered
 * item-by-item, `null`/`undefined` render empty, {@link SafeHtml} from a
 * nested `html\`\`` or {@link raw} passes through). Returns a {@link SafeHtml}
 * that stringifies into a mail definition's `html` field.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? ''
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? '')
  return new SafeHtml(out)
}
