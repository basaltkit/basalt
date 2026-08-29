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

A request for `pt-BR` without a `pt-BR` catalog **negotiates** down to `pt` (the base language); if that doesn't exist either, it falls back to `defaultLocale`. Formatting uses the requested locale (e.g. dates in `pt-BR`) even when the catalog resolved to `pt` — so the words come from the closest catalog while numbers and dates stay regionally correct.

Catalog lookup uses `Object.hasOwn`, so a locale of `__proto__` or `constructor` can never resolve `Object.prototype` members as if they were catalogs.

A key that exists in **no** catalog — not the negotiated one, not `defaultLocale`'s — is not an error: `t()` returns the key itself (`'checkout.title'`), which is visible in the UI and easy to grep for, rather than throwing in a request.

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

Fixes the types of a catalog (`{ key: string | PluralForms }`) for autocompletion in `t`. It is an identity function — it returns exactly what you passed.

### `i18nPlugin(options)` → Basalt plugin (`basalt:i18n`)

Registers a single `I18n` instance under the `I18N` token, in the **register** phase. It has no `boot` or `shutdown` step and performs no I/O.

`I18nOptions` — also the constructor argument of `new I18n(...)`:

| Option | Type | Default | Purpose |
|---|---|---|---|
| `locales` | `Record<string, Catalog>` | — (required) | The catalogs, keyed by locale tag. The keys are what locale negotiation matches against. |
| `defaultLocale` | `string` | — (required) | The fallback used for an unresolvable locale, an invalid tag, and a key missing from the requested catalog. Give it a catalog in `locales` — otherwise every fallback lookup misses and `t()` returns raw keys. |
| `resolveLocale` | `() => string \| undefined` | reads `ctx().user.locale`, then `ctx().tenant.locale` | Where the per-request locale comes from. Override when your locale lives somewhere else (an `Accept-Language` header, a URL segment, a session). Returning `undefined` means "use `defaultLocale`". |

### `render(value, locale, params)`

The low-level renderer behind `t()`: applies `Intl.PluralRules` selection (using `params.count`, defaulting to `0`, falling back to the `other` form and then to `''`) and `{param}` interpolation. A `{param}` with no matching entry is left as-is — `{name}` stays `{name}` — so a missing value is visible instead of printing `undefined`.

### `class I18n` / `Translator`

| Member | Description |
|---|---|
| `locale()` | The locale resolved for the current request. |
| `in(locale)` | A `Translator` fixed to a locale. |
| `t(key, params?)` | Translates in the current locale. |
| `n` · `currency` · `date` · `relativeTime` · `list` | Formatting via `Intl` in the current locale. |

> Note: through the `I18N` token, the catalog's generic type is erased (`I18n<Catalog>`). Import the instance created with `defineMessages` directly from your module to keep the key names/types.

### Types

`Catalog` = `Record<string, MessageValue>` · `MessageValue` = `string | PluralForms` · `PluralForms` = `Partial<Record<Intl.LDMLPluralRule, string>>` (`zero`, `one`, `two`, `few`, `many`, `other`).

## Locale validation

The locale usually comes from a user or tenant record — which means it is
**client-controlled data**. Every `Intl` constructor throws a `RangeError` on an invalid
BCP-47 tag, so a single bad profile field (`en_US` with an underscore, `pt_BR`, `!!`, an
empty string) would 500 every page that formats a number or a date. That is a
self-inflicted denial of service one `PATCH /me` away.

**The rule.** Before any locale reaches `Intl`, `I18n` runs it through
`Intl.getCanonicalLocales(locale)`. If that returns a non-empty list, the locale is used
as given. If it returns nothing — or throws — the locale is replaced with
`defaultLocale`. This applies to both `i18n.locale()` (the context-resolved locale) and
`i18n.in(tag)` (an explicit one).

**The error raised: none.** Validation fails *soft*, on purpose. No exception is thrown
and no error class is exported by this package — an invalid tag silently degrades to
`defaultLocale`, because a wrong-looking date is a far better outcome than a 500 on a
page the user cannot fix. If you want to reject bad tags, validate at the write boundary
(the form or route that saves the profile), not at render time.

Catalog lookup is a separate, also-hardened step: it uses `Object.hasOwn`, so
`__proto__` / `constructor` never resolve prototype members as if they were catalogs.

### Failure modes

| Error | Code | HTTP | When |
|---|---|---|---|
| — | — | — | This package throws nothing of its own. |

Symptoms instead:

- **Everything renders in English despite `locale: 'pt'` on the user** — `resolveLocale`
  isn't finding it. The default reads `ctx().user.locale` then `ctx().tenant.locale`;
  outside a request context `tryCtx()` returns `undefined` and you get `defaultLocale`.
- **Translations fall back but dates format correctly for the region** — expected: `pt-BR`
  negotiated down to the `pt` catalog while `Intl` kept `pt-BR`.
- **`t('some.key')` renders the literal `some.key`** — the key is missing from both the
  negotiated catalog and the `defaultLocale` catalog (or `defaultLocale` has no catalog at
  all).
- **A date suddenly formats as if `defaultLocale`** — the stored tag isn't canonical BCP-47
  (`en_US` instead of `en-US`); it was replaced silently.

## How it connects to other modules

- **`@basaltkit/core`** — provides the request context from which the locale comes.
- **`@basaltkit/auth` / `@basaltkit/tenancy`** — put `user`/`tenant` in the context; store a `locale` on them for automatic resolution.
- **`@basaltkit/mailer` / `@basaltkit/notifications`** — translate email/notification content in the recipient's locale.

Guides: [Internationalization](/guide/i18n) · [Tenancy](/guide/tenancy) · [Notifications](/guide/notifications)
