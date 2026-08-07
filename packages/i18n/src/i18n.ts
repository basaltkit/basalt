import { tryCtx } from '@machize/core'
import { render, type Catalog } from './messages.js'

/** A translator/formatter bound to a specific locale. */
export interface Translator<C extends Catalog> {
  readonly locale: string
  t(key: keyof C & string, params?: Record<string, unknown>): string
  /** Format a number. */
  n(value: number, options?: Intl.NumberFormatOptions): string
  currency(value: number, currency: string, options?: Intl.NumberFormatOptions): string
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string
  relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string
  list(items: string[], options?: Intl.ListFormatOptions): string
}

export interface I18nOptions<C extends Catalog> {
  locales: Record<string, C>
  defaultLocale: string
  /**
   * Resolves the request's locale. Default: `ctx().user.locale` then
   * `ctx().tenant.locale` — set either on your user/tenant records.
   */
  resolveLocale?: () => string | undefined
}

const contextLocale = (): string | undefined => {
  const ctx = tryCtx() as { user?: { locale?: string }; tenant?: { locale?: string } } | undefined
  return ctx?.user?.locale ?? ctx?.tenant?.locale
}

/**
 * Locale-aware translation and formatting. Messages come from typed catalogs
 * (with `{param}` interpolation and `Intl.PluralRules`), formatting from the
 * native `Intl` APIs. The active locale is resolved from the request context,
 * with a fallback chain down to `defaultLocale`.
 */
export class I18n<C extends Catalog> {
  constructor(private readonly options: I18nOptions<C>) {}

  /** The locale for the current request (raw — used for formatting). */
  locale(): string {
    const resolve = this.options.resolveLocale ?? contextLocale
    return resolve() ?? this.options.defaultLocale
  }

  /** A translator pinned to an explicit locale. */
  in(locale: string): Translator<C> {
    const catalogLocale = this.catalogLocale(locale)
    return {
      locale,
      t: (key, params = {}) => {
        const value = this.options.locales[catalogLocale]?.[key] ?? this.options.locales[this.options.defaultLocale]?.[key]
        return value === undefined ? String(key) : render(value, catalogLocale, params)
      },
      n: (value, opts) => new Intl.NumberFormat(locale, opts).format(value),
      currency: (value, currency, opts) => new Intl.NumberFormat(locale, { style: 'currency', currency, ...opts }).format(value),
      date: (value, opts) => new Intl.DateTimeFormat(locale, opts).format(value),
      relativeTime: (value, unit, opts) => new Intl.RelativeTimeFormat(locale, opts).format(value, unit),
      list: (items, opts) => new Intl.ListFormat(locale, opts).format(items),
    }
  }

  t(key: keyof C & string, params?: Record<string, unknown>): string {
    return this.in(this.locale()).t(key, params)
  }
  n(value: number, options?: Intl.NumberFormatOptions): string {
    return this.in(this.locale()).n(value, options)
  }
  currency(value: number, currency: string, options?: Intl.NumberFormatOptions): string {
    return this.in(this.locale()).currency(value, currency, options)
  }
  date(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
    return this.in(this.locale()).date(value, options)
  }
  relativeTime(value: number, unit: Intl.RelativeTimeFormatUnit, options?: Intl.RelativeTimeFormatOptions): string {
    return this.in(this.locale()).relativeTime(value, unit, options)
  }
  list(items: string[], options?: Intl.ListFormatOptions): string {
    return this.in(this.locale()).list(items, options)
  }

  /** Negotiates a requested locale down to one we have a catalog for. */
  private catalogLocale(locale: string): string {
    if (this.options.locales[locale]) return locale
    const language = locale.split('-')[0]!
    if (this.options.locales[language]) return language
    return this.options.defaultLocale
  }
}
