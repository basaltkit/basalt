# RFC 0003 — `@basaltkit/inbound-mail`: receiving email as signed raw bytes

- **Status:** Accepted (v0.1 implemented in this change)
- **Author:** basalt-principal-architect
- **Date:** 2026-10-08
- **Affects:** a new `@basaltkit/inbound-mail` 0.1.0. It composes `@basaltkit/http` (`route()`, `rawBody()`) and `@basaltkit/webhooks` (`signPayload`, `verifySignature`). No other package changes or is bumped.
- **Origin:** BK-082 phase 2, raised by the Mukanda app (document ingestion by email).
- **Non-negotiables honoured:** adapter-agnostic HTTP (no adapter code at all); no decorators, no plugin, no token; secure-by-default and fail-closed; the AI/codegen layer is untouched and stays dev-only.

---

## 0. TL;DR

A SaaS that ingests documents by email has to receive a message from a relay or provider, authenticate it, route it to a tenant and parse it. Every app that does this by hand repeats the same two silent mistakes:

1. **It signs or verifies a string instead of the bytes.** MIME is not UTF-8. A relay that decodes, re-encodes or re-serialises the message produces different bytes, and the signature then either fails on every real message or gets switched off.
2. **It trusts `Authentication-Results` written by the sender.** Anyone can put `dmarc=pass` in a header. The only verdict that counts is the one written by a server the app trusts.

This RFC adds one small package that gets both right:

- `signedDriver()` verifies an HMAC over the **exact bytes plus the envelope**, using the framework's existing webhook signature (`t=…,v1=…`).
- `parseInbound()` parses with bounded limits through `postal-mime` and reads `Authentication-Results` (and ARC) **only from configured trusted servers**.
- `inboundMailRoutes()` returns plain `BasaltRoute[]` that route each delivery by its signed recipient address to a handler.

## 1. Scope

**In v0.1**

- A provider-neutral contract: `InboundMail`, `InboundEnvelope`, `InboundMailDriver`.
- One driver, `signedDriver`, plus the relay-side `signInboundMail` and `inboundCanonical`.
- `parseInbound(raw, options)`: pure, bounded MIME parsing with an A-R/ARC trust filter.
- `inboundMailRoutes()`: address routing to handlers, built on `route()` + `rawBody()`.
- A reference Cloudflare Email Routing Worker, shipped as a docs snippet (not a package).

**Deferred.** Each can be added later behind the public `InboundMailDriver` contract without changing it.

| Item | Why not now |
| --- | --- |
| Postmark driver | No consumer. Static Basic auth gives no body integrity and no replay window. Its envelope `from` is really the header From, which would make the contract's own documentation wrong. |
| SES via SNS | Needs SNS X.509 certificate verification and an S3 fetch, because SNS caps content at 150 KB. It is a package's worth of security-sensitive code; wait for a consumer. |
| Mailgun, SendGrid Inbound Parse | Multipart form posts whose signatures cover form fields, not the message. Put them behind the signed relay instead. |
| IMAP polling | A scheduler with connection state, not a webhook. A relay script covers it through the signed driver. |
| Built-in dedupe | See §6. A check-before-handle loses mail when the handler fails. |
| `saveAttachments` helper | `Files.upload` is already one call. Shipped as a docs recipe. |
| Multi-recipient deliveries | One recipient per signed POST, which is how Cloudflare Email Routing invokes a Worker anyway. |
| Custom MIME pre-scan | postal-mime 4.0.2 has native depth and header-size limits. A second MIME parser would disagree with the first. |
| Rejecting before the body is read | There is no per-route pre-read hook. The 10 MiB default cap and `meta.rateLimit` mitigate it. |
| A default `meta.rateLimit` | Opt-in through `meta`, because the limiter warns when none is installed. |
| zip / nested `.eml` expansion, HTML sanitisation, DKIM/SPF re-verification, a worker-thread mode, a `create-basalt add inbound-mail` scaffold, an opt-in "reject unrouted" mode | App policy, DNS-dependent, or would reintroduce the address oracle. The worker/queue mode is documented as a pattern. |
| Mukanda's old `<t>.<recipient>.<bytes>` framing | The app can accept both formats during its own cutover (§8). |

## 2. Packaging

- A new package, `@basaltkit/inbound-mail`. It is **not** part of `@basaltkit/mailer`: the mailer is send-only and depends only on core, and send-only apps should not pay for http, webhooks and a MIME parser. It is not called `mailer-inbound`, because the `mailer-*` prefix means "a mailer driver" (`mailer-smtp`).
- Dependencies: `@basaltkit/core`, `@basaltkit/http`, `@basaltkit/webhooks` (only for `signPayload`/`verifySignature`/`MIN_WEBHOOK_SECRET_LENGTH`; `@basaltkit/drives` set the precedent), and `postal-mime@^4.0.2`.
- Peer: `zod ^4`, like its siblings. No dependency on `@basaltkit/files`.
- No plugin and no token: there is no shared stateful service, so a plugin would add nothing. `inboundMailRoutes()` returns routes that the app registers like `driveRoutes()`.

### 2.1 Why postal-mime

- MIT-0, zero dependencies, ESM, typed, by the nodemailer/mailparser author. It runs on Node and in Workers, and it handles RFC 2047/2231 and charsets through `TextDecoder`.
- Version 4.0.2 ships the limits this needs: `maxNestingDepth`, `maxHeadersSize`, `maxRfc822NestingDepth`, `forceRfc822Attachments` and `attachmentEncoding`.
- Rejected: `mailparser` (a stream pipeline over a dozen packages, much more audit surface for hostile input) and a hand-written parser (MIME edge cases are where home-grown code gets exploited).

The package always calls it with:

```ts
{ maxRfc822NestingDepth: 0, forceRfc822Attachments: true, attachmentEncoding: 'arraybuffer',
  maxNestingDepth: limits.maxDepth, maxHeadersSize: limits.maxHeaderBytes }
```

A nested `message/rfc822` part therefore comes back as a raw attachment and is never recursed into.

## 3. Wire format v1 (frozen)

One HTTP `POST` carries **one** delivery for **one** recipient.

| Header | Content |
| --- | --- |
| `content-type` | `message/rfc822` or `application/octet-stream` (parameters ignored) |
| `x-basalt-signature` | `t=<unix seconds>,v1=<hex>[,v1=<hex>]` |
| `x-basalt-mail-from` | SMTP `MAIL FROM` as the relay saw it; may be empty (a bounce) |
| `x-basalt-mail-to` | the one SMTP `RCPT TO` of this delivery |
| `x-basalt-mail-oversize` | optional: the original size, when the relay refused to forward the bytes |

The body is the raw message, or empty when `oversize` is set. The header names can be changed through `SignedDriverOptions.headers`.

```
canonical = utf8("basalt-inbound-v1\n" + from + "\n" + to + "\n" + (oversize ?? "") + "\n") ++ raw
signature = signPayload(canonical, secrets, t)      // HMAC-SHA256 over `${t}.` ++ canonical
```

The envelope is inside the signature. Without that, a captured delivery could be replayed to another tenant by editing an unsigned header. The version prefix leaves room for a future framing.

The receiver verifies with `verifySignature(header, canonical, secret, tolerance)` and tries each configured secret (`[current, previous]` during rotation).

**Validation, in order:**

1. Content-Type essence not allowed: **415** `INBOUND_MAIL_UNSUPPORTED_TYPE`.
2. `from`/`to` must be single addresses in printable ASCII (no CR, LF, NUL, comma or other control character; SMTPUTF8 addresses are not supported in v1, because HTTP header values are not reliably UTF-8 across stacks), at most 320 characters, `to` non-empty and containing `@`. `oversize`, when present, must be a positive integer, and then the body must be empty. Any failure: **400** `INBOUND_MAIL_MALFORMED`.
3. Signature missing, stale or wrong: **401** `INBOUND_MAIL_UNAUTHORIZED`, with a generic message that never says which check failed.

### 3.1 Golden vector

```
secret    = "whsec_golden_vector_secret_000000"
t         = 1767225600
from      = "sender@example.org"
to        = "invoices@in.example.com"
oversize  = (absent)
raw (hex) = 46726f6d3a2061406578616d706c652e6f72670d0a546f3a20696e766f6963657340696e2e
            6578616d706c652e636f6d0d0a5375626a6563743a20636166e90d0a436f6e74656e742d5472
            616e736665722d456e636f64696e673a20386269740d0a0d0a6f6ce10d0a
            (8-bit Latin-1: "café", "olá" — deliberately not valid UTF-8)
canonical = 167 bytes, sha256 0fa4587fc4e0262710fba7a5740b79de53b19d863e62748592dc6b57d68f2913
header    = t=1767225600,v1=3050e2bf199d9a502990e01ff3af1043fcee57f6c5577620eff706f74f784755
```

`packages/inbound-mail/tests/signed-driver.test.ts` asserts this vector. Changing it is a breaking change to the wire format, and needs a `v2` prefix.

## 4. Parsing and limits

`parseInbound(raw, options)` is pure: no I/O, no DNS, no network. It is safe in a `worker_thread` or a queue job.

| Limit | Default | Enforced | On breach |
| --- | --- | --- | --- |
| `maxRawBytes` | 10 MiB | before parsing | 422 |
| `maxHeaderBytes` | 64 KiB | postal-mime `maxHeadersSize` | 422 |
| `maxDepth` | 8 | postal-mime `maxNestingDepth` | 422 |
| `maxParts` | 200 | after parsing (attachments + bodies) | 422 |
| `maxAttachments` | 50 | after parsing | 422 |
| `maxAttachmentBytes` | 10 MiB each, decoded | after parsing | 422 |
| `maxTotalAttachmentBytes` | 25 MiB | after parsing | 422 |
| `maxTextBytes` | 2 MiB each for text and html | after parsing | truncated and flagged |

Limit errors are `InboundMailLimitError` (422 `INBOUND_MAIL_LIMIT`, `details: { limit, value }`). Parsing is fully in-memory: postal-mime decodes every attachment into its own buffer. The documented worst case is about 3–4× the request cap per concurrent request, which is why the primary pattern is "ack fast: store `mail.raw` through Files and parse in a queue job or worker".

Attachment filenames are sanitised: basename only; control, bidi and NUL characters removed; at most 255 UTF-8 bytes; fallback `attachment-<n>`. The declared content type is kept as `declaredContentType`, which is the sender's claim and is not trusted. HTML is returned as an untrusted string and is never rendered, fetched or sanitised.

## 5. Authentication-Results and ARC trust rule

Ported from Mukanda's `authOf` (production code and tests):

1. Consider only `Authentication-Results` headers whose authserv-id (RFC 8601, the first token, compared case-insensitively) is in `trustedAuthservIds`. Take the **topmost** such header. A receiving MTA prepends its own, so the topmost is the last hop.
2. The trusted MTA **must strip** incoming `Authentication-Results` headers that carry its own id (RFC 8601 §5). Otherwise a sender could write one with the trusted id. This is a deployment requirement, and the docs say so. Cloudflare Email Routing and the large providers do this.
3. No trusted id configured, or no trusted header present: every verdict is `unknown`. A trusted header that does not mention a method: that method is `none`.
4. ARC fallback, applied only when the trusted header has `dmarc != pass` and `arc=pass`: take the highest-instance `ARC-Seal`. If its `d=` is in `trustedArcSealers`, use the `ARC-Authentication-Results` with the same `i=` and set `arcSealer`. This is the forwarding case BK-082 exists for: a company forwards its own `invoices@` to the app, SPF and DKIM break, and DMARC fails at the app's MTA. The verdict that counts is what the forwarder (Google, Microsoft) saw before it forwarded.
5. The package never re-verifies DKIM or SPF. That needs DNS, and is out of scope.

## 6. No built-in dedupe: `deliveryKey`

The proposal had a `dedupe(key) => seen` callback. It was dropped for two reasons:

- It is a check-and-set that runs **before** the handler. A handler that throws returns 500 and the relay retries, but the retry is already "seen", is acknowledged as a duplicate, and the mail is lost.
- A key built from `Message-ID` is chosen by the sender. An outside sender could send a mail to tenant B with the Message-ID of an invoice expected by tenant A and suppress it.

Instead every `InboundMail` carries `deliveryKey`: `sha256hex(raw) + ":" + to`. It depends only on the signed bytes and the signed recipient, so it is stable across relay retries and differs per recipient. An oversize notice has no bytes, so its key is `"oversize:" + sha256hex(canonical)`, which covers the sender, recipient and declared size. Handlers must be idempotent on it. The docs give a cache-backed recipe that records the key only **after** the handler succeeds.

## 7. Routing and the request pipeline

`inboundMailRoutes({ driver, routes, url?, parse?, meta?, onUnrouted?, hooks? })` returns one `POST` route (default `/inbound/mail`) with `body: rawBody({ maxBytes: driver.maxRequestBytes })` and `meta` merged over `{ auth: false }`. The signature is the authentication. An empty `routes` list throws at construction.

Address patterns are an exact address, `{param}` placeholders in the local part or the domain, or a predicate. Matching is case-insensitive, and a `+tag` subaddress is split off before matching. A `{param}` captures only `[a-z0-9_-]{1,63}`; a capture that does not fit is a non-match, so the mail counts as unrouted rather than reaching `tenancy.run` with an invalid id. The first matching route wins.

1. `driver.receive()` fails: hook `inbound-mail:rejected` `{ reason, source }`, then 415/400/401.
2. No route matches: `onUnrouted`, hook `inbound-mail:unrouted`, then **200 `{ accepted: true }`**. This is the same body as a routed delivery, so there is no address-existence oracle.
3. The handler throws: 500 through the normal `HttpError` sanitisation, and the relay retries. An `InboundMailLimitError` from `ctx.parse()` gives 422, which is permanent.
4. Success: 200 `{ accepted: true }`.

Logs and hooks never carry the raw message or the addresses: only the source, the reason and an 8-hex sha256 prefix of the bytes.

The package never resolves a tenant. The handler reads `match.params`, **checks that the tenant exists**, and enters the tenant plane with `tenancy.run`. This is the "two planes" pattern: the route lives on the central plane.

## 8. Mukanda migration

Mukanda's Worker signs `<t>.<recipient>.<bytes>` with `x-mukanda-*` headers. To move to the package:

1. Deploy the v1 Worker from the docs (same secret, ≥ 32 characters, header names configurable).
2. During the cutover, the app accepts both formats: its existing route for `x-mukanda-signature`, and `inboundMailRoutes()` on a new path for the v1 format. Retire the old route once the Worker is redeployed.
3. Replace its `authOf` with `parseInbound(..., { trustedAuthservIds: ['mx.cloudflare.net'], trustedArcSealers: [...] })`. zip and nested `.eml` expansion stay in the app.

BK-082 is marked shipped in Mukanda's backlog as a separate change in that repository.

## 9. Security summary

- Fail-closed construction: a secret shorter than `MIN_WEBHOOK_SECRET_LENGTH` (16) throws; empty `routes` throws.
- Verification covers the bytes plus the envelope. Routing uses only the signed envelope, never `To:`, `Cc:` or `Delivered-To:`.
- The 10 MiB default request cap is 10× the `rawBody()` default, and is an explicit decision for an unauthenticated endpoint. Going larger is opt-in.
- Replay: a 300 s timestamp tolerance; idempotency through `deliveryKey`.
- No HTML execution, no remote fetches. Attachments should go through `Files.upload` with `requireScan`.
- Runtime package: no AI or MCP imports.
