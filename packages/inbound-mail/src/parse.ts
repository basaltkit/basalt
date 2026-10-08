import PostalMime, { type Address, type Email } from 'postal-mime'
import { authResultsOf, type AuthTrustOptions, type InboundAuthResults } from './auth-results.js'
import { InboundMailLimitError, InboundMailMalformedError, type InboundLimitName } from './errors.js'

const MiB = 1024 * 1024

/** Bounds on what {@link parseInbound} accepts. Every value must be a positive integer. */
export interface InboundParseLimits {
  /** Largest message, checked before parsing. Default 10 MiB. */
  maxRawBytes?: number
  /** Largest total header size across every MIME part (postal-mime `maxHeadersSize`). Default 64 KiB. */
  maxHeaderBytes?: number
  /** Deepest MIME nesting (postal-mime `maxNestingDepth`). Default 8. */
  maxDepth?: number
  /** Most parts (attachments plus the text and html bodies), checked after parsing. Default 200. */
  maxParts?: number
  /** Most attachments. Default 50. */
  maxAttachments?: number
  /** Largest attachment, decoded. Default 10 MiB. */
  maxAttachmentBytes?: number
  /** Largest sum of decoded attachments. Default 25 MiB. */
  maxTotalAttachmentBytes?: number
  /** Longest text or html body, in UTF-8 bytes. Longer bodies are truncated and flagged, not rejected. Default 2 MiB. */
  maxTextBytes?: number
}

export interface ParseInboundOptions extends InboundParseLimits, AuthTrustOptions {}

/** The defaults {@link parseInbound} applies, as documented in RFC 0003 §4. */
export const DEFAULT_INBOUND_PARSE_LIMITS: Readonly<Required<InboundParseLimits>> = Object.freeze({
  maxRawBytes: 10 * MiB,
  maxHeaderBytes: 64 * 1024,
  maxDepth: 8,
  maxParts: 200,
  maxAttachments: 50,
  maxAttachmentBytes: 10 * MiB,
  maxTotalAttachmentBytes: 25 * MiB,
  maxTextBytes: 2 * MiB,
})

export interface InboundAddress {
  name?: string
  address: string
}

export interface InboundAttachment {
  /** Sanitised: basename only, no control, bidi or NUL characters, at most 255 UTF-8 bytes; `attachment-<n>` when empty. */
  filename: string
  /** The sender's claim about the type. Not trusted: sniff the bytes (Files does) before relying on it. */
  declaredContentType: string
  disposition: 'attachment' | 'inline'
  contentId?: string
  /** Decoded size in bytes. */
  size: number
  content: Uint8Array
}

export interface ParsedInboundMail {
  messageId?: string
  subject: string
  from?: InboundAddress
  replyTo: InboundAddress[]
  to: InboundAddress[]
  cc: InboundAddress[]
  date?: Date
  inReplyTo?: string
  references: string[]
  /** The top-level headers in document order, names lower-cased. */
  headers: ReadonlyArray<{ name: string; value: string }>
  text?: string
  /** Untrusted HTML. Never rendered, fetched or sanitised by this package: sanitise before display. */
  html?: string
  truncated: { text: boolean; html: boolean }
  /** Attachments, including nested `message/rfc822` parts as raw attachments (never recursed into). */
  attachments: InboundAttachment[]
  auth: InboundAuthResults
}

function resolveLimits(options: InboundParseLimits): Required<InboundParseLimits> {
  const limits = { ...DEFAULT_INBOUND_PARSE_LIMITS }
  for (const key of Object.keys(DEFAULT_INBOUND_PARSE_LIMITS) as (keyof InboundParseLimits)[]) {
    const value = options[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`parseInbound(): \`${key}\` must be a positive integer.`)
    }
    limits[key] = value
  }
  return limits
}

// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g

/** Truncates `value` to at most `maxBytes` UTF-8 bytes, without splitting a character. */
function clipUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const { read } = new TextEncoder().encodeInto(value, new Uint8Array(maxBytes))
  return value.slice(0, read)
}

/**
 * A filename safe to store, log and show: the basename only (no `/` or `\`
 * path), no control, bidi-override or NUL characters, no leading dots, at most
 * 255 UTF-8 bytes. Falls back to `attachment-<n>`.
 */
export function sanitizeAttachmentName(name: string | null | undefined, index: number): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? ''
  const cleaned = clipUtf8(base.replace(UNSAFE_FILENAME_CHARS, '').trim().replace(/^\.+/, ''), 255).trim()
  return cleaned === '' ? `attachment-${index + 1}` : cleaned
}

function addressesOf(list: readonly Address[] | Address | undefined): InboundAddress[] {
  if (list === undefined) return []
  const out: InboundAddress[] = []
  for (const entry of Array.isArray(list) ? list : [list]) {
    const mailboxes = entry.group ?? [entry]
    for (const mailbox of mailboxes) {
      if (!mailbox.address) continue
      out.push(mailbox.name ? { name: mailbox.name, address: mailbox.address } : { address: mailbox.address })
    }
  }
  return out
}

async function runParser(raw: Uint8Array, limits: Required<InboundParseLimits>): Promise<Email> {
  try {
    return await PostalMime.parse(raw, {
      // A nested message is an attachment, never parsed: its headers and
      // parts are the forwarded sender's, and opening it is the app's policy.
      maxRfc822NestingDepth: 0,
      forceRfc822Attachments: true,
      attachmentEncoding: 'arraybuffer',
      maxNestingDepth: limits.maxDepth,
      maxHeadersSize: limits.maxHeaderBytes,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/nesting depth/i.test(message)) throw new InboundMailLimitError('maxDepth', limits.maxDepth)
    if (/header size/i.test(message)) throw new InboundMailLimitError('maxHeaderBytes', limits.maxHeaderBytes)
    throw new InboundMailMalformedError('The message could not be parsed.', 'message-invalid')
  }
}

function limit(name: InboundLimitName, max: number, value: number): void {
  if (value > max) throw new InboundMailLimitError(name, max, value)
}

/**
 * Parses one raw RFC 5322 message within bounded limits.
 *
 * Pure: no I/O, no DNS, no network. It is safe in a `worker_thread` or a
 * queue job, which is where a large message should be parsed (see the docs:
 * "ack fast, parse in a job"). Parsing is in-memory: every attachment is
 * decoded into its own buffer.
 *
 * Throws `InboundMailLimitError` (422) when a limit is exceeded and
 * `InboundMailMalformedError` (400) when the parser gives up.
 */
export async function parseInbound(raw: Uint8Array, options: ParseInboundOptions = {}): Promise<ParsedInboundMail> {
  const limits = resolveLimits(options)
  limit('maxRawBytes', limits.maxRawBytes, raw.byteLength)
  const email = await runParser(raw, limits)

  const parts = email.attachments.length + (email.text === undefined ? 0 : 1) + (email.html === undefined ? 0 : 1)
  limit('maxParts', limits.maxParts, parts)
  limit('maxAttachments', limits.maxAttachments, email.attachments.length)

  let total = 0
  const attachments = email.attachments.map((attachment, index): InboundAttachment => {
    const content =
      attachment.content instanceof Uint8Array
        ? attachment.content
        : typeof attachment.content === 'string'
          ? new TextEncoder().encode(attachment.content)
          : new Uint8Array(attachment.content)
    limit('maxAttachmentBytes', limits.maxAttachmentBytes, content.byteLength)
    total += content.byteLength
    limit('maxTotalAttachmentBytes', limits.maxTotalAttachmentBytes, total)
    const out: InboundAttachment = {
      filename: sanitizeAttachmentName(attachment.filename, index),
      declaredContentType: attachment.mimeType || 'application/octet-stream',
      disposition: attachment.disposition === 'inline' ? 'inline' : 'attachment',
      size: content.byteLength,
      content,
    }
    if (attachment.contentId) out.contentId = attachment.contentId
    return out
  })

  const text = email.text === undefined ? undefined : clipUtf8(email.text, limits.maxTextBytes)
  const html = email.html === undefined ? undefined : clipUtf8(email.html, limits.maxTextBytes)
  const date = email.date === undefined ? undefined : new Date(email.date)

  const parsed: ParsedInboundMail = {
    subject: email.subject ?? '',
    replyTo: addressesOf(email.replyTo),
    to: addressesOf(email.to),
    cc: addressesOf(email.cc),
    references: (email.references ?? '').split(/\s+/).filter((ref) => ref !== ''),
    headers: email.headers.map((header) => ({ name: header.key, value: header.value })),
    truncated: { text: text !== email.text, html: html !== email.html },
    attachments,
    auth: authResultsOf(email.headers, options),
  }
  const from = addressesOf(email.from)[0]
  if (from) parsed.from = from
  if (email.messageId) parsed.messageId = email.messageId
  if (email.inReplyTo) parsed.inReplyTo = email.inReplyTo
  if (date !== undefined && !Number.isNaN(date.getTime())) parsed.date = date
  if (text !== undefined) parsed.text = text
  if (html !== undefined) parsed.html = html
  return parsed
}
