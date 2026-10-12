import { describe, expect, it } from 'vitest'
import { applyEnvChanges, envValues, formatValue, parseEnv, UnwritableValueError } from '../src/dotenv.js'

describe('parseEnv', () => {
  it('reads pairs, keeps comments and blank lines, reads quotes without a shell', () => {
    const doc = parseEnv('# comment\n\nA=1\nexport B="two words"\nC=\'$HOME literal\'\nD=x # trailing\nE=\n')
    expect(Object.fromEntries(envValues(doc))).toEqual({ A: '1', B: 'two words', C: '$HOME literal', D: 'x', E: '' })
    expect(doc.problems).toEqual([])
  })

  it('reports a value split over two lines by line number, never by value (incident 5)', () => {
    // What a prompt echoing to stdout wrote into the Acme .env.
    const doc = parseEnv('A=1\nPAYCO_SECRET_TOKEN="\nsk_live_abcdef"\nB=2\n')
    expect(doc.problems.map((p) => p.line)).toEqual([2, 3])
    expect(JSON.stringify(doc.problems)).not.toContain('sk_live_abcdef')
  })

  it('reports a key set twice', () => {
    expect(parseEnv('A=1\nA=2\n').problems).toEqual([{ line: 2, message: expect.stringContaining('already set on line 1') }])
  })

  it('treats prototype names as ordinary keys', () => {
    const values = envValues(parseEnv('constructor=1\n__proto__=x\ntoString=y\n'))
    expect(values.get('__proto__')).toBe('x')
    expect(values.get('constructor')).toBe('1')
    expect(values.has('hasOwnProperty')).toBe(false)
  })
})

describe('formatValue', () => {
  it('leaves URLs and hex bare, quotes the rest in a form every reader agrees on', () => {
    expect(formatValue('postgresql://u:p@127.0.0.1:5434/db?schema=public')).toBe('postgresql://u:p@127.0.0.1:5434/db?schema=public')
    expect(formatValue('Globex <no-reply@example.com>')).toBe("'Globex <no-reply@example.com>'")
    expect(formatValue('a $b')).toBe("'a $b'")
    expect(formatValue("it's")).toBe('"it\'s"')
  })

  it('refuses a value no quoting reads the same everywhere', () => {
    expect(() => formatValue("it's $5", 'X')).toThrow(UnwritableValueError)
    expect(() => formatValue('two\nlines', 'X')).toThrow(UnwritableValueError)
  })

  it('round-trips through parseEnv', () => {
    for (const value of ['plain', 'with space', 'a#b', "it's", 'x=y&z', '']) {
      expect(envValues(parseEnv(`K=${formatValue(value)}\n`)).get('K')).toBe(value)
    }
  })
})

describe('applyEnvChanges', () => {
  it('changes a key on its own line, appends new keys, drops removed ones, keeps comments', () => {
    const doc = parseEnv('# keep me\nA=1\nPAYCO_FAKE=0\nB=2\n')
    const text = applyEnvChanges(doc, [
      { kind: 'set', key: 'A', value: 'new', reason: '' },
      { kind: 'remove', key: 'PAYCO_FAKE', reason: '' },
      { kind: 'set', key: 'C', value: 'with space', reason: '' },
    ])
    expect(text).toBe("# keep me\nA=new\nB=2\n\n# Added by basalt-deploy\nC='with space'\n")
  })
})
