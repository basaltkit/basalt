<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/i18n

Internationalization for Basalt: **locale resolved from context** (per user/tenant), **typed message catalogs** with interpolation and plurals, and **formatting** (numbers, currency, dates, relative time, lists) via native `Intl`. **Zero dependencies**. You need this module when your application serves users in multiple languages/regions.

## What this module solves

In a request, whoever is responding needs to know what language to speak — and that's usually the user's (or tenant's) locale. This module automatically resolves the locale from the request context, translates typed messages (with `{parameters}` and correct plurals per language), and formats numbers/dates/currency with the region's rules — all using the `Intl` already built into the runtime.

## Installation

```bash
pnpm add @basaltkit/i18n
```

Depends only on `@basaltkit/core`. No external catalogs or services — messages live in code.

## Getting started in 5 minutes

```ts
import { createApp } from '@basaltkit/core'
import { i18nPlugin, I18N, defineMessages } from '@basaltkit/i18n'

const en = defineMessages({
  greeting: 'Hi {name}',
  notes: { one: '{count} note', other: '{count} notes' },
})
const pt = defineMessages({
  greeting: 'Olá {name}',
  notes: { one: '{count} nota', other: '{count} notas' },
})

const app = await createApp({
  plugins: [i18nPlugin({ locales: { en, pt }, defaultLocale: 'en' })],
}).boot()

const i18n = app.container.get(I18N)

// explicit locale
i18n.in('pt').t('greeting', { name: 'Ada' }) // 'Olá Ada'
i18n.in('en').t('notes', { count: 3 })        // '3 notes'
```

Inside a request, `i18n.t(...)` uses the **context's** locale — no need to pass anything:

```ts
i18n.t('greeting', { name: user.name }) // uses ctx().user.locale (or tenant.locale)
```

## Locale from context

By default, the locale comes from `ctx().user.locale` and, as a fallback, `ctx().tenant.locale` — it's enough to store a `locale` field on those records. Provide your own resolution if you prefer:

```ts
i18nPlugin({ locales, defaultLocale: 'en', resolveLocale: () => ctx().user?.preferredLocale })
```

A request for `pt-BR` without a `pt-BR` catalog **negotiates** down to `pt` (the base language); if that doesn't exist either, it falls back to `defaultLocale`. Formatting uses the requested locale (e.g. dates in `pt-BR`).

## Plurals

A message can be an object of plural forms (CLDR categories: `one`, `other`, `few`, `many`…), chosen by `Intl.PluralRules` based on `count`:

```ts
const en = defineMessages({ items: { one: '{count} item', other: '{count} items' } })
i18n.in('en').t('items', { count: 1 }) // '1 item'
i18n.in('en').t('items', { count: 5 }) // '5 items'
```

## Formatting (Intl)

Every `t` comes with formatters in the same locale:

```ts
const l = i18n.in('en')
l.n(1234.5)                    // '1,234.5'
l.currency(9.9, 'USD')         // '$9.90'
l.date(new Date(), { dateStyle: 'long' })
l.relativeTime(-1, 'day')      // '1 day ago'
l.list(['a', 'b', 'c'])        // 'a, b, and c'
```

## API reference

### `defineMessages(catalog)`

Fixes the types of a catalog (`{ key: string | pluralForms }`) for autocompletion in `t`.

### `i18nPlugin({ locales, defaultLocale, resolveLocale? })`

Registers the `I18N` token. `locales` is `{ [locale]: catalog }`.

### `class I18n` / `Translator`

| Member | Description |
|---|---|
| `locale()` | The locale resolved for the current request. |
| `in(locale)` | A `Translator` fixed to a locale. |
| `t(key, params?)` | Translates in the current locale. |
| `n` · `currency` · `date` · `relativeTime` · `list` | Formatting via `Intl` in the current locale. |

> Note: through the `I18N` token, the catalog's generic type is erased. Import the instance created with `defineMessages` directly from your module to keep the key names/types.

## Locale validation

The resolved locale is client-controlled data: an invalid BCP-47 tag
(`en_US`, `!!`) falls back to `defaultLocale` before reaching `Intl`, so a bad
profile field cannot 500 every formatted page. Catalog lookup uses
`Object.hasOwn`, so `__proto__`/`constructor` never resolve prototype members.

## How it connects to other modules

- **`@basaltkit/core`** — provides the request context from which the locale comes.
- **`@basaltkit/auth` / `@basaltkit/tenancy`** — put `user`/`tenant` in the context; store a `locale` on them for automatic resolution.
- **`@basaltkit/mailer` / `@basaltkit/notifications`** — translate email/notification content in the recipient's locale.
