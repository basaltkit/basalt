---
"@basaltkit/mailer": minor
---

Add a mail preview dev server — the runtime behind `basalt mail:preview`.

- **`createMailPreviewServer(previews, { from?, layout? })`** — a zero-dependency `node:http` server that renders every registered mail (HTML with the shared layout, plaintext, and metadata) in the browser, reusing the mailer's own `resolve` so the preview is faithful to what a driver would send. Invalid sample data renders an error card instead of crashing.
- **`definePreview({ mail, data, label? })`** — type-checks sample data against a mail's schema.
- **`mailerPlugin({ previews: [...] })`** registers a `mail:preview` command (`--port`, default 3737) into the CLI command bucket.
- Exposes the pure `renderPreviewResponse` router for testing/embedding.
