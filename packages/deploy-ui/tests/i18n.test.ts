import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CATALOGS, pickLocale, reasonText, SERVER_PATTERNS_PT, SERVER_TEXT_PT, serverText, setLocale, t, type MessageKey } from '../src/client/i18n.js'
import { checkTarget, checkTargetsFile } from '../src/targets.js'

/**
 * The page's two catalogs stay in step (same keys, same placeholders, same
 * plural forms), the language is picked as documented, and the local
 * server's sentences the page translates are the ones it really says.
 */

afterEach(() => setLocale('en', []))

const placeholders = (value: unknown) => [...new Set(JSON.stringify(value).match(/\{\w+\}/g) ?? [])].sort()

describe('the catalogs', () => {
  it('English and Portuguese have the same keys, placeholders and plural forms', () => {
    const { en, pt } = CATALOGS
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(placeholders(pt[key]), key).toEqual(placeholders(en[key]))
      expect(typeof pt[key], key).toBe(typeof en[key])
      if (typeof en[key] === 'object') expect(Object.keys(pt[key]).sort(), key).toEqual(Object.keys(en[key]).sort())
      expect(JSON.stringify(pt[key]).length, `${key} is empty`).toBeGreaterThan(2)
    }
  })

  it('fills placeholders and picks plural forms in the page\'s language', () => {
    expect(t('targets.count', { count: 1 })).toBe('1 target')
    expect(t('targets.count', { count: 3 })).toBe('3 targets')
    setLocale('pt', ['pt-AO'])
    expect(t('targets.count', { count: 1 })).toBe('1 destino')
    expect(t('targets.count', { count: 3 })).toBe('3 destinos')
    // European plural rules (as in Angola), whatever variant the browser names.
    setLocale('pt', ['pt-BR'])
    expect(t('targets.count', { count: 0 })).toBe('0 destinos')
    expect(t('plan.deployTo', { name: 'staging' })).toBe('Fazer deploy para staging?')
    // A value is inserted once, never read again as a template.
    expect(t('plan.deployTo', { name: '{name}' })).toBe('Fazer deploy para {name}?')
  })

  it('a commit list\'s reason is fixed local text; anything else is "no usable reason"', () => {
    setLocale('pt')
    expect(reasonText('shallow')).toMatch(/clone superficial/)
    for (const odd of ['none', 'constructor', '__proto__', 42, undefined, '<b>x</b>']) expect(reasonText(odd)).toBe('o servidor não deu um motivo utilizável')
  })
})

describe('picking the language', () => {
  it('the saved choice, else the browser\'s first language the page speaks, else English', () => {
    expect(pickLocale('pt', ['en-US'])).toBe('pt')
    expect(pickLocale(undefined, ['fr-FR', 'pt-AO', 'en'])).toBe('pt')
    expect(pickLocale(undefined, ['PT-br'])).toBe('pt')
    expect(pickLocale('fr', ['de'])).toBe('en')
    expect(pickLocale(undefined, [])).toBe('en')
    expect(pickLocale('__proto__', [])).toBe('en')
  })
})

describe('the local server\'s sentences', () => {
  const sources = async () => (await Promise.all(['targets.ts', 'server.ts', 'remote.ts', 'stream.ts'].map((f) => readFile(join(import.meta.dirname, '..', 'src', f), 'utf8'))))
    .join('\n').replaceAll('\\\'', '\'')

  it('every translated sentence is one the server says, word for word', async () => {
    const text = await sources()
    for (const sentence of Object.keys(SERVER_TEXT_PT)) expect(text, sentence).toContain(sentence)
  })

  it('every refusal of a target field is translated', () => {
    setLocale('pt')
    const refused = checkTarget({ name: 'Bad Name', ssh: '-oProxyCommand=x', port: 0, dir: 'relative', node: '../node', config: '/abs', protected: 'yes' })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    for (const [field, message] of Object.entries(refused.errors)) expect(serverText(message), field).not.toBe(message)
    expect(serverText('letters, digits and ._@+-, at most 64')).toBe('letras, dígitos e ._@+-, no máximo 64')
  })

  it('patterns translate only a name of the server\'s own grammar; anything else is shown unchanged', () => {
    setLocale('pt')
    expect(serverText('"staging" is already a target')).toBe('"staging" já é um destino')
    expect(serverText('a change to production is already in progress from this UI')).toBe('já está em curso uma alteração a production a partir desta UI')
    expect(serverText('"Évil <b>" is already a target')).toBe('"Évil <b>" is already a target')
    expect(serverText('the tree is dirty')).toBe('the tree is dirty')
    expect(SERVER_PATTERNS_PT.length).toBeGreaterThan(0)
    setLocale('en')
    expect(serverText('no ssh client was found')).toBe('no ssh client was found')
  })
})

describe('the language in the targets file', () => {
  it('is kept when it is one the page speaks, refused otherwise', () => {
    const file = checkTargetsFile({ version: 1, locale: 'pt', targets: [] })
    expect(file).toEqual({ ok: true, value: { version: 1, locale: 'pt', targets: [] } })
    const wrong = checkTargetsFile({ version: 1, locale: 'fr', targets: [] })
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.errors['locale']).toBe('one of en, pt')
  })
})
