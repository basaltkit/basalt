# @basaltkit/inbound-mail

## 0.1.0

### Minor Changes

- 6aaa374: New package `@basaltkit/inbound-mail` (0.1.0, BK-082 phase 2, RFC 0003). It receives email from a relay as signed raw bytes. `signedDriver()` verifies wire format v1: the `t=…,v1=…` webhook signature over `basalt-inbound-v1` framing that covers the envelope and the exact message bytes, one recipient per request, with secret rotation and an optional signed oversize notice. `signInboundMail()` and `inboundCanonical()` are the relay-side helpers. `parseInbound()` parses with postal-mime within size, depth, header, part and attachment limits (422 `INBOUND_MAIL_LIMIT`). It never recurses into nested messages, sanitises attachment filenames, and reads SPF, DKIM and DMARC only from `Authentication-Results` written by `trustedAuthservIds`, with an ARC fallback for `trustedArcSealers`. `inboundMailRoutes()` returns a `rawBody()` route (10 MiB default cap) that routes by the signed recipient to handlers, with `{param}` patterns and `+tag` splitting. Unrouted mail gets the same 200 as routed mail. Handlers get a memoised `ctx.parse()` and a `deliveryKey` derived from the signed data for idempotency. Behaviour is the same on Fastify, Express and Hono. Not included yet: Postmark, SES/SNS, Mailgun and SendGrid drivers, and IMAP polling.

### Patch Changes

- Updated dependencies [0353877]
- Updated dependencies [7a3fd88]
- Updated dependencies [eeb90bb]
- Updated dependencies [e600b0a]
- Updated dependencies [e74b21b]
- Updated dependencies [3ce3446]
- Updated dependencies [f029638]
- Updated dependencies [3740447]
- Updated dependencies [8b76628]
- Updated dependencies [36b800c]
- Updated dependencies [500edef]
- Updated dependencies [870075a]
- Updated dependencies [194931a]
- Updated dependencies [1868e07]
- Updated dependencies [bbb8463]
  - @basaltkit/http@2.8.0
  - @basaltkit/core@1.6.0
  - @basaltkit/webhooks@4.1.0
