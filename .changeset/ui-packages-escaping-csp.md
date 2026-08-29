---
"@basaltkit/api-keys-ui": minor
"@basaltkit/teams-ui": minor
"@basaltkit/billing-ui": minor
"@basaltkit/audit-viewer": minor
---

**Security (S-5): standardized escaping, `</script>`-safe embedded state, and a hash-locked route-scoped CSP by default.**

**What was exposed (latent).** Three of the four pages' client-side `esc()` helpers omitted `"` yet were used inside double-quoted attributes — an attribute-breakout XSS trap the moment API data carries a quote; server-side `title`/`roles` were interpolated unescaped; and `JSON.stringify`'d state (`apiBase`, `headers`, `roles`) could terminate the inline `<script>` block (`JSON.stringify` does not escape `/`). Separately — and live — every page ships inline style/script that `securityPlugin`'s `DEFAULT_CSP` blocks, with no documented alternative, pushing operators toward `contentSecurityPolicy: false` app-wide.

**What changed.** All four pages: server-side interpolations go through the shared `escapeHtml` (`@basaltkit/http`); embedded state uses `scriptJson` (cannot break out of the script block); the client-side `esc()` charset is unified to `& < > " '`. Each route now sets a route-scoped CSP by default — everything denied, the page's own inline script allowed only by sha256 hash (new exports `apiKeysPageCsp`/`teamsPageCsp`/`billingPageCsp`/`auditViewerCsp`; new route option `csp: string | false` to override or opt out). The pages now work under the strict app-wide CSP without weakening it.
