import { HttpError } from '@basaltkit/http'

/**
 * Why a delivery was refused, for the operator. It travels on the log-only
 * `internalDetails` channel (never in the response body), so the caller cannot
 * tell which check failed.
 */
export type InboundRejectionReason =
  | 'missing-signature'
  | 'bad-signature'
  | 'unsupported-type'
  | 'envelope-invalid'
  | 'oversize-invalid'

/**
 * 401 `INBOUND_MAIL_UNAUTHORIZED`: the signature is missing, stale or wrong.
 *
 * The message is the same for every cause on purpose. A relay that is set up
 * correctly never sees this, and an attacker learns nothing from it.
 */
export class InboundMailUnauthorizedError extends HttpError {
  constructor(reason: InboundRejectionReason = 'bad-signature') {
    super(401, 'INBOUND_MAIL_UNAUTHORIZED', 'The inbound mail delivery could not be authenticated.', {
      internalDetails: { reason },
    })
  }
}

/** 400 `INBOUND_MAIL_MALFORMED`: the delivery or the message cannot be used as sent. */
export class InboundMailMalformedError extends HttpError {
  constructor(message: string, reason: InboundRejectionReason | 'message-invalid' | 'oversize' = 'envelope-invalid') {
    super(400, 'INBOUND_MAIL_MALFORMED', message, { internalDetails: { reason } })
  }
}

/** 415 `INBOUND_MAIL_UNSUPPORTED_TYPE`: the body is not declared as `message/rfc822` or `application/octet-stream`. */
export class InboundMailUnsupportedTypeError extends HttpError {
  constructor() {
    super(
      415,
      'INBOUND_MAIL_UNSUPPORTED_TYPE',
      'An inbound mail delivery must be sent as message/rfc822 or application/octet-stream.',
      { internalDetails: { reason: 'unsupported-type' } },
    )
  }
}

/** The parse limits an {@link InboundMailLimitError} can name. */
export type InboundLimitName =
  | 'maxRawBytes'
  | 'maxHeaderBytes'
  | 'maxDepth'
  | 'maxParts'
  | 'maxAttachments'
  | 'maxAttachmentBytes'
  | 'maxTotalAttachmentBytes'

/**
 * 422 `INBOUND_MAIL_LIMIT`: the message is over one of the parse limits.
 *
 * A 4xx is permanent for every relay, which is what an oversized or
 * pathologically nested message deserves: retrying it can never succeed.
 * `details.value` is the measured value when one is known (the parser reports
 * depth and header-size breaches without one).
 */
export class InboundMailLimitError extends HttpError {
  constructor(
    readonly limit: InboundLimitName,
    readonly max: number,
    readonly value?: number,
  ) {
    super(422, 'INBOUND_MAIL_LIMIT', `The message is over the ${limit} limit (${max}).`, {
      details: value === undefined ? { limit, max } : { limit, max, value },
    })
  }
}
