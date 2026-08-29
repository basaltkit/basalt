---
"@basaltkit/mailer": minor
---

**Security: safe-by-default HTML mail bodies via the `html\`\`` tagged template.**

**What was exposed.** Mail bodies are HTML built from schema data that is usually user-controlled (names, titles). The documented idiom interpolated it bare — `html: ({ name }) => \`<h1>Hello ${name}</h1>\`` — so a crafted value injected markup into mail sent from your own DKIM/SPF-aligned domain (phishing content, tracking pixels, XSS in permissive webmail). The only `escapeHtml` was module-private.

**What changed.** New `html\`\`` tagged template escapes **every** interpolation automatically — the safe path is now the default path, not a thing to remember. It returns a composable `SafeHtml` (nested `html\`\`` results and `raw()` fragments pass through un-re-escaped; arrays render item-by-item; `null`/`undefined` render empty), and stringifies straight into a mail definition's `html` field (its return type is widened to `string | SafeHtml`, backward-compatible). `escapeHtml`, `html`, `raw`, and `SafeHtml` are now exported. Docs (README + notifications/cookbook, EN+PT) updated to the safe idiom. Separately, `Mailer.deliver()` (the queue-worker path) now runs the same `assertHeaderSafe` header-injection guard as `send()`. Existing `html: (data) => string` definitions keep working unchanged — but plain template strings are not escaped, so prefer `html\`\``.
