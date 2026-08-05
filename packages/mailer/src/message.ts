import { MachizeError } from '@machize/core'

/** Structural schema compatible with Zod. */
export interface MailSchema<T> {
  safeParse(input: unknown): { success: boolean; data?: T; error?: unknown }
}

export class MailValidationError extends MachizeError {
  constructor(
    readonly mail: string,
    readonly issues: unknown,
  ) {
    super('MAIL_INVALID', `Invalid data for mail "${mail}": ${JSON.stringify(issues)}`)
  }
}

export class MailIncompleteError extends MachizeError {
  constructor(field: 'to' | 'from') {
    super(
      'MAIL_INCOMPLETE',
      field === 'to'
        ? 'Mail has no recipient. Pass `to` in the envelope.'
        : 'Mail has no sender. Pass `from` in the envelope or configure a default in mailerPlugin.',
    )
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
