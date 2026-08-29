---
"@basaltkit/i18n": patch
---

**Security (S-7): a client-controlled locale can no longer 500 formatted pages.** `ctx().user.locale` / `ctx().tenant.locale` are user-editable data, but were handed raw to `Intl.NumberFormat`/`DateTimeFormat`/etc. — an invalid BCP-47 tag (`en_US` with an underscore, `!!`) made every `n()`/`currency()`/`date()` call throw `RangeError`, a self-inflicted denial of service on the user's own pages. The resolved locale is now validated via `Intl.getCanonicalLocales` and falls back to `defaultLocale` when invalid (the returned `Translator.locale` reflects the effective locale). Catalog negotiation also uses `Object.hasOwn`, so a locale of `__proto__`/`constructor` can never resolve `Object.prototype` members as catalogs.
