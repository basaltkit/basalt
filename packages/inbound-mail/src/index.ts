/**
 * `@basaltkit/inbound-mail`: receive email as signed raw bytes, parse it within
 * bounds, and route it by its signed recipient. See RFC 0003.
 */
export type { InboundEnvelope, InboundMail, InboundMailDriver, InboundMailDriverInput } from './contract.js'
export {
  InboundMailUnauthorizedError,
  InboundMailMalformedError,
  InboundMailUnsupportedTypeError,
  InboundMailLimitError,
  type InboundLimitName,
  type InboundRejectionReason,
} from './errors.js'
export {
  signedDriver,
  signInboundMail,
  inboundCanonical,
  DEFAULT_INBOUND_MAX_REQUEST_BYTES,
  type SignedDriverOptions,
  type SignInboundMailOptions,
  type InboundHeaderNames,
} from './signed.js'
export {
  parseInbound,
  sanitizeAttachmentName,
  DEFAULT_INBOUND_PARSE_LIMITS,
  type InboundParseLimits,
  type ParseInboundOptions,
  type ParsedInboundMail,
  type InboundAddress,
  type InboundAttachment,
} from './parse.js'
export {
  authResultsOf,
  type AuthVerdict,
  type InboundAuthResults,
  type AuthTrustOptions,
  type HeaderField,
} from './auth-results.js'
export { type InboundRouteMatch, type InboundAddressPattern } from './routing.js'
export {
  inboundMailRoutes,
  type InboundMailContext,
  type InboundMailRoute,
  type InboundMailRoutesOptions,
  type InboundRejectedReason,
} from './routes.js'
