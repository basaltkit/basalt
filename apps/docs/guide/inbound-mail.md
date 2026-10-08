# Inbound mail

`@basaltkit/inbound-mail` receives email in a Basalt app. A relay posts each
message to the app as **signed raw bytes**, one recipient per request. The route
checks the signature, routes the message by its signed recipient address, and
gives your handler a bounded parser that only believes authentication verdicts
from servers you trust.

```bash
pnpm add @basaltkit/inbound-mail
```

The package is opt-in and stateless: no plugin, no token, no storage, no
migrations. `inboundMailRoutes()` returns ordinary routes, like
[`driveRoutes()`](/guide/drives#routes), and they run unchanged on Fastify,
Express and Hono. The design is recorded in RFC 0003
(`docs/rfcs/0003-basaltkit-inbound-mail.md`).

[[toc]]

## Why bytes, not strings

An app that receives mail by hand usually gets two things wrong, and neither
causes a visible error.

1. **It signs or verifies a string instead of the bytes.** MIME is not UTF-8.
   An 8-bit Latin-1 message decoded to a string and encoded again is a different
   message, so a signature over it either fails on real mail or ends up switched
   off. The relay signs the exact octets, the route reads them with
   [`rawBody()`](/guide/adapters#raw-request-bodies-webhook-signatures), and
   nothing in between decodes them.
2. **It trusts an `Authentication-Results` header the sender wrote.** Anyone
   can put `dmarc=pass` in a header. `parseInbound()` only reads verdicts
   written by servers you list. See [Authentication-Results and ARC](#authentication-results-and-arc).

## Quick start

### 1. The relay: Cloudflare Email Routing

Route `*@in.example.com` (a catch-all) to a Worker. The Worker reads the raw
message, signs it with wire format v1 and posts it to your app. Store both
secrets with `wrangler secret put`. The secret must be at least 16 characters
(use `generateWebhookSecret()` from `@basaltkit/webhooks`).

```js
// Cloudflare Email Routing -> Basalt relay (wire format v1, RFC 0003).
// Secrets: BASALT_INBOUND_URL and BASALT_INBOUND_SECRET (wrangler secret put).
const MAX_BYTES = 10 * 1024 * 1024 // keep in step with signedDriver({ maxRequestBytes })
const encoder = new TextEncoder()

export async function signDelivery(raw, from, to, oversize, secret, t) {
  // HMAC-SHA256 over `${t}.` ++ canonical, canonical = framing ++ raw bytes.
  const prefix = encoder.encode(`${t}.`)
  const head = encoder.encode(`basalt-inbound-v1\n${from}\n${to}\n${oversize ?? ''}\n`)
  const signed = new Uint8Array(prefix.length + head.length + raw.length)
  signed.set(prefix)
  signed.set(head, prefix.length)
  signed.set(raw, prefix.length + head.length)
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed))
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  const headers = {
    'content-type': 'message/rfc822',
    'x-basalt-signature': `t=${t},v1=${hex}`,
    'x-basalt-mail-from': from,
    'x-basalt-mail-to': to,
  }
  if (oversize !== undefined) headers['x-basalt-mail-oversize'] = String(oversize)
  return headers
}

export default {
  async email(message, env) {
    // Over the ceiling, only a signed notice with the size is sent.
    const oversize = message.rawSize > MAX_BYTES ? message.rawSize : undefined
    const raw = oversize === undefined ? new Uint8Array(await new Response(message.raw).arrayBuffer()) : new Uint8Array(0)
    const t = Math.floor(Date.now() / 1000)
    const headers = await signDelivery(raw, message.from, message.to, oversize, env.BASALT_INBOUND_SECRET, t)
    const res = await fetch(env.BASALT_INBOUND_URL, { method: 'POST', body: raw, headers })
    // Throwing makes Email Routing answer the sending server with a temporary
    // failure, so it retries later: right for a 5xx, and for a 401, which
    // means the two secrets disagree (an operator error a retry can outlive).
    if (res.status >= 500 || res.status === 401) throw new Error(`inbound mail endpoint answered ${res.status}`)
    // Any other 4xx is permanent (malformed, over a limit): bounce it.
    if (res.status >= 400) message.setReject(`rejected (${res.status})`)
  },
}
```

The package's test suite runs this exact Worker against `signedDriver`, so the
snippet and the driver cannot drift apart. Any other relay (an IMAP poller, a
Lambda, your own MTA) can sign the same way. From Node, call
`signInboundMail(raw, { from, to }, secret)` and send the headers it returns.

### 2. The route

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify'
import { inboundMailRoutes, signedDriver } from '@basaltkit/inbound-mail'

const mailRoutes = inboundMailRoutes({
  driver: signedDriver({ secret: [process.env.INBOUND_SECRET!] }),
  parse: {
    trustedAuthservIds: ['mx.cloudflare.net'],
    trustedArcSealers: ['google.com', 'outlook.com'],
  },
  meta: { rateLimit: { limit: 60, windowMs: 60_000 } },
  routes: [
    {
      address: '{tenant}@in.example.com',
      async handler({ mail, match, parse }) {
        const tenant = await tenancy.find(match.params.tenant!)
        if (!tenant) return // unknown company: accept and drop
        await tenancy.run(tenant, async () => {
          const parsed = await parse()
          // … store mail.raw, file the attachments, record parsed.auth.dmarc
        })
      },
    },
  ],
})

await createApp({ plugins: [fastifyPlugin({ routes: [...appRoutes, ...mailRoutes] })] }).boot()
```

The route is `POST /inbound/mail` by default (change it with `url`). It is
declared with `meta: { auth: false }`, because the signature is the
authentication. Your `meta` is merged over that default.

## Wire format v1

One `POST` carries one delivery for one recipient.

| Header | Content |
| --- | --- |
| `content-type` | `message/rfc822` or `application/octet-stream` (parameters such as `; charset=` are ignored) |
| `x-basalt-signature` | `t=<unix seconds>,v1=<hex>`, with one `v1=` per secret during a rotation |
| `x-basalt-mail-from` | SMTP `MAIL FROM` as the relay saw it. May be empty (a bounce). |
| `x-basalt-mail-to` | the one SMTP `RCPT TO` of this delivery |
| `x-basalt-mail-oversize` | optional: the original size, when the relay did not forward the bytes |

The signature is the [webhook signature](/guide/webhooks#verifying-raw-bytes),
taken over a canonical message that includes the envelope:

```
canonical = utf8("basalt-inbound-v1\n" + from + "\n" + to + "\n" + (oversize ?? "") + "\n") ++ raw
header    = signPayload(canonical, secrets, t)
```

The envelope is inside the signature. Otherwise a captured delivery could be
replayed to another tenant by editing an unsigned header. Addresses must be
single, printable-ASCII addresses of at most 320 characters. The format is
frozen by a golden vector in RFC 0003 and in the tests. The header names can be
changed through `signedDriver({ headers })` and `signInboundMail(…, { headers })`.

To rotate the secret, configure `secret: [next, current]` on the server first,
then switch the relay to `next`, then drop `current`.

## Routing and tenancy

`address` is one of:

- an exact address: `'invoices@in.example.com'`;
- `{param}` placeholders in the local part or the domain:
  `'{tenant}@in.example.com'`, `'invoices@{tenant}.in.example.com'`;
- a predicate: `(address) => ({ kind: 'support' })` or `false`.

Matching is case-insensitive. A `+tag` subaddress is split off before matching,
so `acme+march@in.example.com` matches `'{tenant}@in.example.com'` with
`match.tag === 'march'` (the tag is sender-chosen text). A `{param}` captures only
`[a-z0-9_-]{1,63}`. Anything else (`a.b`, `%`, quoted local parts) is a
non-match. Routes are tried in order and the first match wins.

**No route matching is not an error.** `onUnrouted(address, mail)` runs, the
`inbound-mail:unrouted` hook fires, and the response is the same
`200 { "accepted": true }` that a routed delivery gets. The endpoint therefore
cannot be used to find out which addresses exist.

The package never resolves a tenant. The route lives on the central plane (see
[the multi-tenant pattern](/guide/multi-tenant-pattern)). Your handler takes the
id from `match.params`, **checks that the tenant exists**, and only then enters
the tenant plane with `tenancy.run`.

## Limits

`ctx.parse()` (and `parseInbound()`) enforce these limits. Every value can be
changed through `parse`.

| Limit | Default | When | Over the limit |
| --- | --- | --- | --- |
| request size (`signedDriver({ maxRequestBytes })`) | 10 MiB | while reading the body | `413 PAYLOAD_TOO_LARGE` |
| `maxRawBytes` | 10 MiB | before parsing | `422 INBOUND_MAIL_LIMIT` |
| `maxHeaderBytes` | 64 KiB, total across all parts | while parsing | `422` |
| `maxDepth` | 8 nested multiparts | while parsing | `422` |
| `maxParts` | 200 (attachments plus bodies) | after parsing | `422` |
| `maxAttachments` | 50 | after parsing | `422` |
| `maxAttachmentBytes` | 10 MiB each, decoded | after parsing | `422` |
| `maxTotalAttachmentBytes` | 25 MiB | after parsing | `422` |
| `maxTextBytes` | 2 MiB each for text and html | after parsing | truncated, `truncated.text`/`truncated.html` set |

A nested `message/rfc822` part comes back as a raw attachment and is never
parsed. Opening it, like expanding a zip, is your application's policy.

**Memory.** Parsing is fully in-memory: postal-mime decodes every attachment
into its own buffer. Plan for about 3 to 4 times the request cap per concurrent
request. The 10 MiB default is ten times the `rawBody()` default, and it is a
deliberate choice for an endpoint that is unauthenticated until the bytes are in
memory. Raise it explicitly if you need to.

## Ack fast, parse later

The primary pattern is to answer the relay quickly and do the heavy work in a
job. Store `mail.raw` through Files, then dispatch:

```ts
export const ParseInboundMail = defineJob({
  name: 'parse-inbound-mail',
  schema: z.object({ tenantId: z.string(), fileId: z.string(), deliveryKey: z.string() }),
  async handle({ tenantId, fileId }) {
    await tenancy.run(tenantId, async () => {
      const { content } = await files.download(fileId)
      const parsed = await parseInbound(content, { trustedAuthservIds: ['mx.cloudflare.net'] })
      // … file the attachments, record the verdicts
    })
  },
})

// in the route handler, inside tenancy.run:
const stored = await files.upload(mail.raw, { name: 'message.eml', contentType: 'message/rfc822' })
await ParseInboundMail.dispatch({ tenantId: tenant.id, fileId: stored.id, deliveryKey: mail.deliveryKey })
```

`parseInbound()` is pure (no I/O, no DNS, no network), so it is equally safe in
a `worker_thread`.

## Rate limiting

Add `meta: { rateLimit: … }` to the routes so one source cannot flood the
endpoint. It is not set by default, because the rate-limit guard warns when no
limiter is installed. A relay posts from a small set of addresses (Cloudflare's
Worker egress, your MTA), so size the budget for your real mail volume rather
than for one browser. See [Rate limiting](/guide/security#rate-limiting).

## Authentication-Results and ARC

`parsed.auth` gives `{ authservId?, spf, dkim, dmarc, dkimDomains, arcSealer? }`.
Each verdict is `pass`, `fail`, `softfail`, `neutral`, `none`, `temperror`,
`permerror`, `policy` or `unknown`.

- Only `Authentication-Results` headers whose authserv-id is in
  `trustedAuthservIds` count, compared case-insensitively. The topmost one wins.
- **The trusted server must remove incoming `Authentication-Results` headers that
  carry its own id** (RFC 8601 §5). Cloudflare Email Routing and the large mail
  providers do this. Without it, a sender could write a header with the trusted id.
- With no trusted id configured, or no trusted header present, every verdict is
  `unknown`.
- **Forwarded mail.** When a company forwards its own `invoices@` to your
  address, SPF and often DKIM break, and DMARC fails at your MTA. If that MTA
  reports `arc=pass` and the highest `ARC-Seal` was made by a sealer in
  `trustedArcSealers` (say `google.com`), the verdicts come from that sealer's
  `ARC-Authentication-Results`, which record what it saw before forwarding.
  `arcSealer` names the sealer.
- Nothing is re-verified. DKIM and SPF checks need DNS, and are out of scope.

## Attachments into Files

There is no helper for this, because `Files.upload` is already one call. Run it
inside the tenant, with quarantine on (`requireScan: true` on the Files plugin),
so nothing is served before your scanner clears it:

```ts
for (const attachment of parsed.attachments) {
  await files.upload(attachment.content, {
    name: attachment.filename, // already sanitised: basename, no control or bidi characters
    contentType: attachment.declaredContentType, // the sender's claim; Files sniffs the bytes
    metadata: { source: 'inbound-mail', deliveryKey: mail.deliveryKey },
  })
}
```

## HTML safety

`parsed.html` is untrusted HTML. The package never renders it, fetches its
`cid:` or remote resources, or sanitises it. Sanitise it before display, and
serve any page that shows it with a strict CSP through
[per-route headers](/guide/security#per-route-headers-—-meta-headers).

## Idempotency

There is no built-in dedupe. A check before the handler would acknowledge the
retry of a handler that failed, and the mail would be lost. A key built from
`Message-ID` would let one sender suppress another tenant's mail. Instead, every
delivery carries `mail.deliveryKey`:

- `sha256(raw) + ':' + recipient`: stable across relay retries, different per recipient, derived only from signed data;
- for an oversize notice, `'oversize:' + sha256(canonical)`.

Make handlers idempotent on it. Record the key only **after** the work
succeeded:

```ts
async handler({ mail }) {
  const key = `inbound:${mail.deliveryKey}`
  if (await cache.get(key)) return // already processed
  await process(mail)              // throws: 500, the relay retries, nothing was recorded
  await cache.put(key, true, '7d')
}
```

A database unique constraint on the key does the same job without a cache.

## Oversize notices

When a message is over the relay's ceiling, the Worker above does not forward
it. It sends a signed notice instead: an empty body plus
`x-basalt-mail-oversize`. The handler sees `mail.oversize` (the original size)
and an empty `mail.raw`, and can tell the company the message was too large.
`ctx.parse()` on a notice throws `400 INBOUND_MAIL_MALFORMED`.

## Hooks

| Hook | Payload |
| --- | --- |
| `inbound-mail:rejected` | `{ reason, source, detail?, digest }`: refused before routing (`unauthorized`, `malformed`, `unsupported-type`, `too-large`, `error`) |
| `inbound-mail:unrouted` | `{ source, digest }`: authenticated, but no route matched |

`digest` is the first 8 hex characters of the body's sha256. Hooks and logs never
carry the message or the addresses.

## Not included

These may come later as separate drivers behind the public `InboundMailDriver`
contract. Until then, put the provider behind a relay that signs wire format v1.

- **Postmark, Mailgun, SendGrid Inbound Parse.** Static Basic auth or signatures
  over form fields, not over the message.
- **Amazon SES via SNS.** It needs SNS certificate verification and an S3 fetch,
  because SNS caps content at 150 KB.
- **IMAP polling.** Use a small poller that calls `signInboundMail`.
- **Zip or nested `.eml` expansion, HTML sanitisation, DKIM/SPF re-verification.**
  These are application policy or need DNS.
- **Several recipients in one request.** Each recipient is one signed POST.

## Error codes

| Status | Code | When |
| --- | --- | --- |
| 400 | `INBOUND_MAIL_MALFORMED` | invalid envelope, invalid oversize, unparseable message, `parse()` on an oversize notice |
| 401 | `INBOUND_MAIL_UNAUTHORIZED` | signature missing, stale or wrong. The message is the same for every cause. |
| 413 | `PAYLOAD_TOO_LARGE` | the request is over `maxRequestBytes` |
| 415 | `INBOUND_MAIL_UNSUPPORTED_TYPE` | content type other than `message/rfc822` or `application/octet-stream` |
| 422 | `INBOUND_MAIL_LIMIT` | over a parse limit. `details: { limit, max, value? }` |
| 500 | — | your handler threw. The relay retries. |
