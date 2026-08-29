---
"@basaltkit/http": minor
---

**New server-rendered-HTML primitives: `escapeHtml`, `scriptJson`, `pageCsp`/`cspHash` (S-5).** One canonical escaping charset (`& < > " '`, safe in text nodes and single- or double-quoted attributes), a `</script>`-breakout-safe JSON embedder (escapes `<` plus U+2028/U+2029), and a route-scoped CSP builder that allows a page's inline script only by its sha256 hash. These back the `*-ui` packages' hardening and are exported for any app route that returns HTML.
