# @basaltkit/inbound-mail

Receive email in a Basalt app.

- **Signed raw bytes.** A relay (Cloudflare Email Routing, an IMAP poller, your own MTA) posts each message as its exact bytes, one recipient per request. The HMAC covers the bytes **and** the envelope, so a captured delivery cannot be re-routed to another tenant.
- **Bounded parsing.** `parseInbound()` uses [postal-mime](https://github.com/postalsys/postal-mime) with limits on size, depth, header size, parts and attachments. Nested messages are never recursed into, and filenames are sanitised.
- **Trusted verdicts only.** SPF, DKIM and DMARC come only from `Authentication-Results` written by servers you list, with an ARC fallback for forwards sealed by trusted sealers. A header the sender wrote counts for nothing.
- **Address routing.** `'{tenant}@in.example.com'` patterns, `+tag` splitting, the first match wins, and unrouted mail gets the same `200` as routed mail, so the endpoint is not an address oracle.

No plugin, no token, no storage. `inboundMailRoutes()` returns plain routes that run unchanged on Fastify, Express and Hono.

```bash
pnpm add @basaltkit/inbound-mail
```

```ts
import { inboundMailRoutes, signedDriver } from '@basaltkit/inbound-mail'

const routes = inboundMailRoutes({
  driver: signedDriver({ secret: process.env.INBOUND_SECRET! }),
  parse: { trustedAuthservIds: ['mx.cloudflare.net'], trustedArcSealers: ['google.com'] },
  meta: { rateLimit: { limit: 60, windowMs: 60_000 } },
  routes: [
    {
      address: '{tenant}@in.example.com',
      async handler({ mail, match, parse }) {
        const tenant = await tenancy.find(match.params.tenant!)
        if (!tenant) return
        await tenancy.run(tenant, async () => {
          const parsed = await parse()
          // idempotent on mail.deliveryKey; store mail.raw; file parsed.attachments
        })
      },
    },
  ],
})
```

## API

| Export | What it does |
| --- | --- |
| `signedDriver(options)` | Verifies wire format v1 (`x-basalt-signature` over the framing plus the bytes). Secrets of at least 16 characters, `[current, previous]` during rotation, 300 s tolerance, 10 MiB request cap by default. |
| `signInboundMail(raw, envelope, secret, options?)` | The relay side: the headers to send with the bytes. |
| `inboundCanonical(raw, envelope, oversize?)` | The exact bytes v1 signs, for relays in other languages. |
| `parseInbound(raw, options?)` | Pure, bounded parse. Returns subject, addresses, headers, text/html (truncated and flagged), attachments and `auth` verdicts. |
| `authResultsOf(headers, trust)` | The A-R/ARC trust rule on its own. |
| `inboundMailRoutes(options)` | The `POST /inbound/mail` route with routing, hooks and `ctx.parse()`. |

Errors: `INBOUND_MAIL_UNAUTHORIZED` (401), `INBOUND_MAIL_MALFORMED` (400), `INBOUND_MAIL_UNSUPPORTED_TYPE` (415), `INBOUND_MAIL_LIMIT` (422).

There is no built-in dedupe. Make handlers idempotent on `mail.deliveryKey`, which is derived only from the signed bytes and the recipient.

Not included in 0.1: Postmark, SES/SNS, Mailgun and SendGrid drivers, IMAP polling, zip or nested `.eml` expansion, HTML sanitisation, DKIM/SPF re-verification. The `InboundMailDriver` contract is public, so drivers can be added later.

Full guide, including the reference Cloudflare Worker: [Inbound mail](https://basaltkit-docs.pages.dev/guide/inbound-mail). Design and wire format: RFC 0003 (`docs/rfcs/0003-basaltkit-inbound-mail.md`).
