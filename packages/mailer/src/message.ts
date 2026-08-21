import { BasaltError } from '@basaltkit/core'

/** Structural schema compatible with Zod. */
export interface MailSchema<T> {
  safeParse(input: unknown): { success: boolean; data?: T; error?: unknown }
}

export class MailValidationError extends BasaltError {
  constructor(
    readonly mail: string,
    readonly issues: unknown,
  ) {
    super('MAIL_INVALID', `Invalid data for mail "${mail}": ${JSON.stringify(issues)}`)
  }
}

export class MailIncompleteError extends BasaltError {
  constructor(field: 'to' | 'from') {
    super(
      'MAIL_INCOMPLETE',
      field === 'to'
        ? 'Mail has no recipient. Pass `to` in the envelope.'
        : 'Mail has no sender. Pass `from` in the envelope or configure a default in mailerPlugin.',
    )
  }
}

/**
 * Raised when a header-bearing field (subject or an address) carries a CR/LF
 * or an otherwise malformed value — the classic email header-injection vector
 * (`\r\nBcc: evil@x.com`). Thrown at the single envelope-assembly choke point,
 * so every driver is protected, not just SMTP.
 */
export class MailHeaderInjectionError extends BasaltError {
  /** HTTP status for adapters that surface framework errors to clients. */
  readonly status = 400

  constructor(
    readonly field: 'subject' | 'to' | 'cc' | 'bcc' | 'replyTo' | 'from',
    readonly value: string,
  ) {
    super(
      'MAIL_HEADER_INJECTION',
      `Refusing to send: mail field "${field}" contains a line break or a malformed ` +
        `address (possible header injection): ${JSON.stringify(value)}`,
    )
  }
}

/** CR or LF — the raw header-injection vector, illegal anywhere in a header value. */
// eslint-disable-next-line no-control-regex
const NEWLINE = /[\r\n]/
/** Any CR, LF, NUL or other C0/C1 control char — never legal inside an address. */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_NEWLINE = /[\r\n\x00-\x1f\x7f]/

/** Extracts the addr-spec from either `addr@host` or `"Name" <addr@host>`. */
function extractAddrSpec(value: string): string {
  const angle = value.match(/<([^<>]*)>/)
  return (angle ? angle[1]! : value).trim()
}

/**
 * Conservative RFC-5322-ish sanity check — NOT a full parser. Its only job is
 * to block header injection and obvious garbage: no control chars, and the
 * addr-spec must have exactly one `@` (not leading/trailing) and no whitespace.
 * Display-name forms like `"Alice" <alice@example.com>` are allowed.
 */
function isPlausibleAddress(value: string): boolean {
  if (CONTROL_OR_NEWLINE.test(value)) return false
  const addr = extractAddrSpec(value)
  if (addr.length === 0) return false
  if (/\s/.test(addr)) return false
  const at = addr.indexOf('@')
  if (at <= 0 || at !== addr.lastIndexOf('@') || at === addr.length - 1) return false
  return true
}

/**
 * The single header-safety choke point. Every resolved message passes through
 * here before it reaches any driver. Rejects CR/LF in the subject and any
 * malformed/injecting address in from/to/cc/bcc/replyTo.
 */
export function assertHeaderSafe(message: ResolvedMail): void {
  if (NEWLINE.test(message.subject)) {
    throw new MailHeaderInjectionError('subject', message.subject)
  }
  const addressFields: [MailHeaderInjectionError['field'], string[]][] = [
    ['from', [message.from]],
    ['to', message.to],
    ['cc', message.cc],
    ['bcc', message.bcc],
    ['replyTo', message.replyTo ? [message.replyTo] : []],
  ]
  for (const [field, values] of addressFields) {
    for (const value of values) {
      if (!isPlausibleAddress(value)) throw new MailHeaderInjectionError(field, value)
    }
  }
}

export interface Envelope {
  to: string | string[]
  from?: string
  cc?: string | string[]
  bcc?: string | string[]
  replyTo?: string
}

/** Fully resolved message — what drivers receive. */
export interface ResolvedMail {
  mail: string
  to: string[]
  from: string
  cc: string[]
  bcc: string[]
  replyTo?: string | undefined
  subject: string
  text?: string | undefined
  html?: string | undefined
}

export interface MailDefinition<T = void> {
  readonly name: string
  readonly schema?: MailSchema<T> | undefined
  subject(data: T): string
  text?(data: T): string
  html?(data: T): string
}

/**
 * Defines a typed, renderable mail:
 *
 * export const WelcomeEmail = defineMail({
 *   name: 'welcome',
 *   schema: z.object({ name: z.string() }),
 *   subject: ({ name }) => `Welcome, ${name}!`,
 *   text: ({ name }) => `Hello ${name}`,
 *   html: ({ name }) => `<h1>Hello ${name}</h1>`,
 * })
 */
export function defineMail<T = void>(definition: MailDefinition<T>): MailDefinition<T> {
  return definition
}

export function validateMailData<T>(mail: MailDefinition<T>, data: unknown): T {
  if (!mail.schema) return data as T
  const result = mail.schema.safeParse(data)
  if (!result.success) {
    const issues =
      (result.error as { issues?: unknown[] } | undefined)?.issues ?? result.error ?? 'unknown'
    throw new MailValidationError(mail.name, issues)
  }
  return result.data as T
}

export function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}
