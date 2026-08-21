---
"@basaltkit/mailer": minor
---

Add the Mailgun driver and a shared HTML layout hook.

- **`mailgun`** — delivers via the Mailgun HTTP API (no SDK), Basic auth (`api:<key>`) over a form-encoded body, `region: 'us' | 'eu'`: `mailerPlugin({ driver: 'mailgun', mailgun: { apiKey, domain } })`. Non-2xx responses surface as `MailDeliveryError`.
- **`layout`** — `mailerPlugin({ layout: (html, { mail }) => `…${html}…` })` wraps every rendered HTML body once, for shared branding (header/footer, per-tenant colours). Runs per send, so it can read `ctx().tenant`. Any template engine (MJML, React Email, Handlebars) still works inside a mail's own `html()`.
