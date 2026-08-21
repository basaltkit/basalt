---
"@basaltkit/mailer": minor
---

Add two API-based mail drivers, both over HTTPS with no SDK:

- **`resend`** — delivers via the Resend API (`mailerPlugin({ driver: 'resend', resend: { apiKey } })`).
- **`ses`** — Amazon SES v2 `SendEmail`, signed with a hand-rolled SigV4 using `node:crypto` (`mailerPlugin({ driver: 'ses', ses: { region, accessKeyId, secretAccessKey } })`) — keeps the mailer free of the AWS SDK.

Both share the existing envelope and the header-injection guard. New `MailDeliveryError` (`MAIL_DELIVERY_FAILED`) surfaces a provider's non-2xx response. Drivers accept an injectable `fetch` (and SES an injectable clock) for testing.
