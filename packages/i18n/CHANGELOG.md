# @machize/i18n

## 0.22.0

### Patch Changes

- @machize/core@0.22.0

## 0.21.0

### Patch Changes

- @machize/core@0.21.0

## 0.20.0

### Patch Changes

- @machize/core@0.20.0

## 0.19.0

### Patch Changes

- @machize/core@0.19.0

## 0.18.0

### Patch Changes

- @machize/core@0.18.0

## 0.17.0

### Patch Changes

- @machize/core@0.17.0

## 0.16.0

### Patch Changes

- @machize/core@0.16.0

## 0.15.0

### Patch Changes

- @machize/core@0.15.0

## 0.14.0

### Minor Changes

- 4b32d68: New package: `@machize/i18n` — internationalization with zero dependencies.

  `defineMessages` pins typed catalogs (`{ key: string | pluralForms }`) with `{param}` interpolation and CLDR plurals via `Intl.PluralRules`. `I18n` resolves the active locale from the request context (`ctx().user.locale` then `ctx().tenant.locale`, overridable), negotiates a regional locale down to an available catalog (`pt-BR` → `pt`), and falls back to `defaultLocale`, then to the key. `t(key, params)` translates in the current locale; `in(locale)` pins one; and each translator carries `Intl`-based `n`/`currency`/`date`/`relativeTime`/`list` formatters. `i18nPlugin({ locales, defaultLocale, resolveLocale? })` registers the `I18N` token. Fully unit-tested — interpolation, plurals, fallback, locale negotiation, context resolution, and formatting.

### Patch Changes

- @machize/core@0.14.0
