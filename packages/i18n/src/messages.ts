/** Plural forms keyed by CLDR category, picked via `Intl.PluralRules`. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>

/** A message: a template string, or plural forms selected by `count`. */
export type MessageValue = string | PluralForms

/** A message catalog: keys → messages. */
export type Catalog = Record<string, MessageValue>

/** Identity helper that pins a catalog's key/value types for `t()`. */
export function defineMessages<C extends Catalog>(messages: C): C {
  return messages
}

const interpolate = (template: string, params: Record<string, unknown>): string =>
  template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    params[key] === undefined ? `{${key}}` : String(params[key]),
  )

/** Resolves a message value to a string for a locale, applying plurals + params. */
export function render(value: MessageValue, locale: string, params: Record<string, unknown>): string {
  if (typeof value === 'string') return interpolate(value, params)
  const count = Number(params['count'] ?? 0)
  const category = new Intl.PluralRules(locale).select(count)
  const template = value[category] ?? value.other ?? ''
  return interpolate(template, params)
}
