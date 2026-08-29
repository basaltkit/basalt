# @basaltkit/i18n

## 1.0.2

### Patch Changes

- cc4786e: **Security (S-7): a client-controlled locale can no longer 500 formatted pages.** `ctx().user.locale` / `ctx().tenant.locale` are user-editable data, but were handed raw to `Intl.NumberFormat`/`DateTimeFormat`/etc. — an invalid BCP-47 tag (`en_US` with an underscore, `!!`) made every `n()`/`currency()`/`date()` call throw `RangeError`, a self-inflicted denial of service on the user's own pages. The resolved locale is now validated via `Intl.getCanonicalLocales` and falls back to `defaultLocale` when invalid (the returned `Translator.locale` reflects the effective locale). Catalog negotiation also uses `Object.hasOwn`, so a locale of `__proto__`/`constructor` can never resolve `Object.prototype` members as catalogs.

## 1.0.5

### Patch Changes

- Lockstep 1.0.5 release. No code changes in this package; it moves with the
  ecosystem-wide durable/Redis backend expansion (tenancy, events outbox,
  webhooks, rate-limiting, idempotency). Internal `@basaltkit/*` dependencies now
  use caret ranges (`workspace:^`).

## 1.0.0

### Major Changes

- **First stable release.** The public API is now covered by semantic versioning: breaking changes only in a new major, features in a minor, fixes in a patch. No functional change from 0.32.0 — this release marks the stability commitment across the `@basaltkit/*` ecosystem.

## 0.24.0

### Patch Changes

- @basaltkit/core@0.24.0

## 0.23.0

### Patch Changes

- @basaltkit/core@0.23.0

## 0.22.0

### Patch Changes

- @basaltkit/core@0.22.0

## 0.21.0

### Patch Changes

- @basaltkit/core@0.21.0

## 0.20.0

### Patch Changes

- @basaltkit/core@0.20.0

## 0.19.0

### Patch Changes

- @basaltkit/core@0.19.0

## 0.18.0

### Patch Changes

- @basaltkit/core@0.18.0

## 0.17.0

### Patch Changes

- @basaltkit/core@0.17.0

## 0.16.0

### Patch Changes

- @basaltkit/core@0.16.0

## 0.15.0

### Patch Changes

- @basaltkit/core@0.15.0

## 0.14.0

### Minor Changes

- 4b32d68: New package: `@basaltkit/i18n` — internationalization with zero dependencies.

  `defineMessages` pins typed catalogs (`{ key: string | pluralForms }`) with `{param}` interpolation and CLDR plurals via `Intl.PluralRules`. `I18n` resolves the active locale from the request context (`ctx().user.locale` then `ctx().tenant.locale`, overridable), negotiates a regional locale down to an available catalog (`pt-BR` → `pt`), and falls back to `defaultLocale`, then to the key. `t(key, params)` translates in the current locale; `in(locale)` pins one; and each translator carries `Intl`-based `n`/`currency`/`date`/`relativeTime`/`list` formatters. `i18nPlugin({ locales, defaultLocale, resolveLocale? })` registers the `I18N` token. Fully unit-tested — interpolation, plurals, fallback, locale negotiation, context resolution, and formatting.

### Patch Changes

- @basaltkit/core@0.14.0
