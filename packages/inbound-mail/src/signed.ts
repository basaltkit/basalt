import { createHash } from 'node:crypto'
import { MIN_WEBHOOK_SECRET_LENGTH, signPayload, verifySignature } from '@basaltkit/webhooks'
import type { InboundEnvelope, InboundMail, InboundMailDriver, InboundMailDriverInput } from './contract.js'
import { InboundMailMalformedError, InboundMailUnauthorizedError, InboundMailUnsupportedTypeError } from './errors.js'

/** The versioned prefix of the canonical message. Changing the framing means a new prefix. */
const WIRE_PREFIX = 'basalt-inbound-v1\n'

/** Default request cap for the signed driver: 10 MiB. Larger is an explicit opt-in. */
export const DEFAULT_INBOUND_MAX_REQUEST_BYTES = 10 * 1024 * 1024

/** Longest address accepted in the envelope (RFC 5321: 64 for the local part + 1 + 255). */
const MAX_ADDRESS_LENGTH = 320

/** The content types a delivery may declare. Parameters (`; charset=…`) are ignored. */
const ACCEPTED_TYPES = new Set(['message/rfc822', 'application/octet-stream'])

/** The header names of wire format v1. Each can be renamed through the options. */
export interface InboundHeaderNames {
  signature?: string
  from?: string
  to?: string
  oversize?: string
}

const DEFAULT_HEADERS: Required<InboundHeaderNames> = {
  signature: 'x-basalt-signature',
  from: 'x-basalt-mail-from',
  to: 'x-basalt-mail-to',
  oversize: 'x-basalt-mail-oversize',
}

export interface SignedDriverOptions {
  /**
   * The shared secret, or `[current, previous]` while rotating. Each must be at
   * least `MIN_WEBHOOK_SECRET_LENGTH` characters, or the constructor throws.
   */
  secret: string | readonly string[]
  /** How old (or how far in the future) a signature timestamp may be. Default 300 seconds. */
  toleranceSeconds?: number
  /** The largest request accepted. Default {@link DEFAULT_INBOUND_MAX_REQUEST_BYTES} (10 MiB). */
  maxRequestBytes?: number
  /** Header names, when the relay cannot use the defaults. */
  headers?: InboundHeaderNames
}

export interface SignInboundMailOptions {
  /** The signature timestamp. Default: now. */
  nowSeconds?: number
  /** The original size, when the relay is sending an oversize notice instead of the bytes (`raw` must be empty). */
  oversize?: number
  /** Header names, when the receiver was configured with different ones. */
  headers?: InboundHeaderNames
}

/**
 * Why an envelope cannot be framed, or `undefined` when it can.
 *
 * The framing separates fields with `\n`, so a field holding a line break would
 * let a relay's value be read as two fields. A comma would make a list of
 * recipients out of one. Neither is a legitimate single address.
 */
function envelopeProblem(envelope: InboundEnvelope, oversize: number | undefined, rawLength: number): string | undefined {
  for (const [field, value] of [['from', envelope.from], ['to', envelope.to]] as const) {
    if (typeof value !== 'string') return `envelope ${field} must be a string`
    if (value.length > MAX_ADDRESS_LENGTH) return `envelope ${field} is longer than ${MAX_ADDRESS_LENGTH} characters`
    // eslint-disable-next-line no-control-regex
    if (/[\r\n\u0000,]/.test(value)) return `envelope ${field} must be a single address`
  }
  if (envelope.to.trim() === '' || !envelope.to.includes('@')) return 'envelope to must be an address'
  if (oversize !== undefined) {
    if (!Number.isSafeInteger(oversize) || oversize < 1) return 'oversize must be a positive integer'
    if (rawLength !== 0) return 'an oversize notice must not carry the message'
  }
  return undefined
}

/**
 * The exact bytes wire format v1 signs:
 * `utf8("basalt-inbound-v1\n" + from + "\n" + to + "\n" + (oversize ?? "") + "\n") ++ raw`.
 *
 * Exported for relays written in other languages and for tests. Throws a
 * `TypeError` on an envelope that cannot be framed unambiguously.
 */
export function inboundCanonical(raw: Uint8Array, envelope: InboundEnvelope, oversize?: number): Uint8Array {
  const problem = envelopeProblem(envelope, oversize, raw.byteLength)
  if (problem !== undefined) throw new TypeError(`inboundCanonical(): ${problem}`)
  return frame(raw, envelope, oversize)
}

function frame(raw: Uint8Array, envelope: InboundEnvelope, oversize: number | undefined): Buffer {
  const head = Buffer.from(`${WIRE_PREFIX}${envelope.from}\n${envelope.to}\n${oversize ?? ''}\n`, 'utf8')
  return Buffer.concat([head, raw])
}

function secretsOf(secret: string | readonly string[], caller: string): readonly string[] {
  const secrets = typeof secret === 'string' ? [secret] : [...secret]
  if (secrets.length === 0) throw new TypeError(`${caller}: at least one secret is required.`)
  for (const value of secrets) {
    if (typeof value !== 'string' || value.length < MIN_WEBHOOK_SECRET_LENGTH) {
      throw new TypeError(`${caller}: every secret must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters.`)
    }
  }
  return secrets
}

/**
 * The relay side: the headers to send with `raw` as the body of a `POST`.
 *
 * Use it from a Node relay (an IMAP poller, an SMTP hook, a Lambda). The
 * Cloudflare Worker in the docs does the same with WebCrypto.
 */
export function signInboundMail(
  raw: Uint8Array,
  envelope: InboundEnvelope,
  secret: string | readonly string[],
  options: SignInboundMailOptions = {},
): Record<string, string> {
  const secrets = secretsOf(secret, 'signInboundMail()')
  const names = { ...DEFAULT_HEADERS, ...options.headers }
  const canonical = inboundCanonical(raw, envelope, options.oversize)
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const headers: Record<string, string> = {
    'content-type': 'message/rfc822',
    [names.signature]: signPayload(canonical, secrets, now),
    [names.from]: envelope.from,
    [names.to]: envelope.to,
  }
  if (options.oversize !== undefined) headers[names.oversize] = String(options.oversize)
  return headers
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** The key {@link InboundMail.deliveryKey} documents. */
function deliveryKeyOf(raw: Uint8Array, canonical: Uint8Array, to: string, oversize: number | undefined): string {
  return oversize === undefined ? `${sha256Hex(raw)}:${to}` : `oversize:${sha256Hex(canonical)}`
}

/** One header value; a repeated header is ambiguous and therefore refused. */
function single(headers: InboundMailDriverInput['headers'], name: string): string | undefined {
  const lower = name.toLowerCase()
  let value: string | string[] | undefined
  for (const [key, candidate] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      if (value !== undefined) throw new InboundMailMalformedError(`The ${name} header was sent more than once.`)
      value = candidate
    }
  }
  if (Array.isArray(value)) {
    if (value.length > 1) throw new InboundMailMalformedError(`The ${name} header was sent more than once.`)
    return value[0]
  }
  return value
}

/**
 * The driver for wire format v1: an HMAC over the exact message bytes and the
 * envelope, in the framework's `t=…,v1=…` webhook signature format.
 *
 * Any relay can produce it: the Cloudflare Email Routing Worker in the docs, an
 * IMAP poller, a Lambda, or the app's own MTA. See RFC 0003 for the framing and
 * its golden vector.
 */
export function signedDriver(options: SignedDriverOptions): InboundMailDriver {
  const secrets = secretsOf(options.secret, 'signedDriver()')
  const tolerance = options.toleranceSeconds ?? 300
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new TypeError('signedDriver(): `toleranceSeconds` must be a finite number >= 0.')
  }
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_INBOUND_MAX_REQUEST_BYTES
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1) {
    throw new TypeError('signedDriver(): `maxRequestBytes` must be a positive integer.')
  }
  const names = { ...DEFAULT_HEADERS, ...options.headers }

  return {
    name: 'signed',
    maxRequestBytes,
    async receive({ body, headers }): Promise<InboundMail> {
      if (body.contentType === undefined || !ACCEPTED_TYPES.has(body.contentType)) {
        throw new InboundMailUnsupportedTypeError()
      }
      const raw: Uint8Array = body.bytes
      const from = single(headers, names.from) ?? ''
      const to = single(headers, names.to) ?? ''
      const rawOversize = single(headers, names.oversize)
      let oversize: number | undefined
      if (rawOversize !== undefined) {
        // Digits only: `Number('1e3')` or `Number(' 12 ')` would be accepted otherwise.
        if (!/^[1-9][0-9]{0,15}$/.test(rawOversize)) {
          throw new InboundMailMalformedError('The oversize header must be a positive integer.', 'oversize-invalid')
        }
        oversize = Number(rawOversize)
      }
      const envelope = { from, to }
      const problem = envelopeProblem(envelope, oversize, raw.byteLength)
      if (problem !== undefined) {
        throw new InboundMailMalformedError(
          `The delivery envelope is not valid: ${problem}.`,
          oversize !== undefined && problem.includes('oversize') ? 'oversize-invalid' : 'envelope-invalid',
        )
      }

      const signature = single(headers, names.signature)
      if (signature === undefined || signature === '') throw new InboundMailUnauthorizedError('missing-signature')
      // The framing signs the values exactly as the relay sent them; the
      // lower-cased recipient is derived only after they verified.
      const canonical = frame(raw, envelope, oversize)
      let valid = false
      for (const secret of secrets) {
        if (verifySignature(signature, canonical, secret, tolerance)) valid = true
      }
      if (!valid) throw new InboundMailUnauthorizedError('bad-signature')

      const recipient = to.toLowerCase()
      const mail: InboundMail = {
        raw,
        envelope: { from, to: recipient },
        source: 'signed',
        receivedAt: new Date(),
        deliveryKey: deliveryKeyOf(raw, canonical, recipient, oversize),
      }
      if (oversize !== undefined) mail.oversize = oversize
      return mail
    },
  }
}
