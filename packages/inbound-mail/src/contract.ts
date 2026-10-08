import type { RawBody } from '@basaltkit/http'

/** The SMTP envelope of one delivery, as reported (and signed) by the relay. */
export interface InboundEnvelope {
  /** SMTP `MAIL FROM` as the relay saw it. May be `''` (a bounce). Not the `From:` header. */
  from: string
  /**
   * The ONE SMTP `RCPT TO` of this delivery, lower-cased. Routing uses only this,
   * never `To:`, `Cc:` or `Delivered-To:` (which the sender writes).
   */
  to: string
}

/** One authenticated delivery, as a driver hands it to the routes. */
export interface InboundMail {
  /** The exact message bytes as delivered, never re-serialised. Empty when {@link InboundMail.oversize} is set. */
  raw: Uint8Array
  envelope: InboundEnvelope
  /** The driver that authenticated it (`'signed'`, or a custom driver's name). */
  source: string
  /**
   * The original size the relay declared when it refused to forward the bytes
   * (over its own ceiling). The message itself is absent; the delivery is a
   * signed notice that a message was too large.
   */
  oversize?: number
  receivedAt: Date
  /**
   * A key that is stable across relay retries of this delivery and differs per
   * recipient: `sha256hex(raw) + ':' + envelope.to`. It is derived only from
   * signed data, never from headers the sender wrote (`Message-ID`), so one
   * sender cannot use it to suppress another tenant's mail. For an oversize
   * notice it is `'oversize:' + sha256hex(canonical)`, which covers the sender,
   * the recipient and the declared size. Make handlers idempotent on it.
   */
  deliveryKey: string
}

/** What a driver receives: the raw body of the request and its headers. */
export interface InboundMailDriverInput {
  body: RawBody
  headers: Readonly<Record<string, string | string[] | undefined>>
}

/**
 * Authenticates and decodes one HTTP delivery.
 *
 * A driver must verify over `body.bytes` and never over a re-parse of them.
 * It throws `InboundMailUnauthorizedError` (401) on any authentication failure,
 * `InboundMailMalformedError` (400) on an unusable delivery and
 * `InboundMailUnsupportedTypeError` (415) on a wrong content type.
 */
export interface InboundMailDriver {
  readonly name: string
  /** The largest request this driver accepts; it becomes the route's `rawBody({ maxBytes })`. */
  readonly maxRequestBytes: number
  receive(input: InboundMailDriverInput): Promise<InboundMail>
}
