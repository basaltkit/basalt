---
'@basaltkit/dashboard': minor
---

White-label branding: a `Branding` model (product name, logo, favicon, colours,
support links) with a per-tenant `BrandingStore`. `resolveBranding` merges a
tenant's overrides over a default brand (deep-merging colours/cssVars),
`brandingCssVars`/`brandingStyleSheet` turn it into CSS custom properties the
shell injects, and `Dashboard` now carries `branding` — its title defaults to
`branding.productName`. Pure and browser-safe.
