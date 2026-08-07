import { describe, expect, it } from 'vitest'
import { createApp, runWithContext } from '@machize/core'
import { I18N, I18n, defineMessages, i18nPlugin } from '../src/index.js'

const en = defineMessages({
  hi: 'Hi {name}',
  items: { one: '{count} item', other: '{count} items' },
  onlyEn: 'English only',
})
const pt = defineMessages({
  hi: 'Olá {name}',
  items: { one: '{count} item', other: '{count} itens' },
  onlyEn: '', // present as empty to exercise real fallback below via a missing key
})

const make = (resolveLocale?: () => string | undefined) =>
  new I18n({ locales: { en, pt }, defaultLocale: 'en', ...(resolveLocale ? { resolveLocale } : {}) })

describe('translation', () => {
  it('interpolates params in the chosen locale', () => {
    const i18n = make()
    expect(i18n.in('en').t('hi', { name: 'Ada' })).toBe('Hi Ada')
    expect(i18n.in('pt').t('hi', { name: 'Ada' })).toBe('Olá Ada')
  })

  it('applies plural rules', () => {
    const i18n = make()
    expect(i18n.in('en').t('items', { count: 1 })).toBe('1 item')
    expect(i18n.in('en').t('items', { count: 5 })).toBe('5 items')
    expect(i18n.in('pt').t('items', { count: 5 })).toBe('5 itens')
  })

  it('falls back to the default locale, then to the key', () => {
    // pt intentionally lacks most keys — the cast keeps `en`'s key type.
    const i18n = new I18n<typeof en>({ locales: { en, pt: { hi: 'Olá {name}' } as typeof en }, defaultLocale: 'en' })
    // 'onlyEn' missing in pt → English value
    expect(i18n.in('pt').t('onlyEn')).toBe('English only')
    // missing everywhere → the key itself
    expect(i18n.in('pt').t('missing' as never)).toBe('missing')
  })

  it('negotiates a regional locale down to an available catalog', () => {
    const i18n = make()
    expect(i18n.in('pt-BR').t('hi', { name: 'X' })).toBe('Olá X') // pt-BR → pt catalog
  })

  it('resolves the locale from the request context', () => {
    const i18n = make()
    const value = runWithContext({ user: { id: 'u1', locale: 'pt' } } as never, () => i18n.t('hi', { name: 'Ada' }))
    expect(value).toBe('Olá Ada')
    // no context → default locale
    expect(i18n.t('hi', { name: 'Ada' })).toBe('Hi Ada')
  })
})

describe('formatting (Intl)', () => {
  it('formats numbers, currency, lists and relative time by locale', () => {
    const i18n = make()
    expect(i18n.in('en').n(1234.5)).toBe('1,234.5')
    expect(i18n.in('en').currency(9.9, 'USD')).toBe('$9.90')
    expect(i18n.in('en').list(['a', 'b', 'c'])).toBe('a, b, and c')
    expect(i18n.in('en').relativeTime(-1, 'day')).toBe('1 day ago')
  })
})

describe('i18nPlugin', () => {
  it('registers the I18N service', async () => {
    const app = await createApp({ plugins: [i18nPlugin({ locales: { en, pt }, defaultLocale: 'en' })] }).boot()
    expect(app.container.get(I18N).in('pt').t('hi', { name: 'Z' })).toBe('Olá Z')
    await app.shutdown()
  })
})
