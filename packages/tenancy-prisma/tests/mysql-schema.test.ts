import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tenancyMysqlColumnLimits } from '../src/index.js'

/**
 * `columnLimits: 'mysql'` is only right while it matches the native types in
 * `schema.mysql.prisma`, and that schema is only right while it declares the
 * same columns as `schema.prisma`. Both are hand-maintained; this locks them.
 */

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

interface Field {
  name: string
  type: string
  attrs: string
}

function models(schema: string): Map<string, Field[]> {
  const out = new Map<string, Field[]>()
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)\n\}/gm)) {
    const fields = m[2]!
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => line.length > 0 && !line.startsWith('@@'))
      .map((line) => {
        const [name, type, ...rest] = line.split(/\s+/)
        return { name: name!, type: type!, attrs: rest.join(' ') }
      })
    out.set(m[1]!, fields)
  }
  return out
}

/** The capacity a MySQL `String` column has, from its native-type attribute. */
function capacity(attrs: string): unknown {
  if (/@db\.MediumText\b/.test(attrs)) return { bytes: 16_777_215 }
  if (/@db\.LongText\b/.test(attrs)) return { bytes: 4_294_967_295 }
  if (/@db\.Text\b/.test(attrs)) return { bytes: 65_535 }
  const varchar = /@db\.VarChar\((\d+)\)/.exec(attrs)
  return varchar ? Number(varchar[1]) : 191
}

const base = read('../prisma/schema.prisma')
const mysql = read('../prisma/schema.mysql.prisma')
const PRESET = tenancyMysqlColumnLimits as Record<string, Record<string, unknown>>

describe('schema.mysql.prisma and the mysql column-limit preset', () => {
  it('uses the mysql provider', () => {
    expect(mysql).toMatch(/provider\s*=\s*"mysql"/)
  })

  it('declares the same models and columns as schema.prisma', () => {
    const a = models(base)
    const b = models(mysql)
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort())
    for (const [model, fields] of a) {
      expect(b.get(model)!.map((f) => f.name), model).toEqual(fields.map((f) => f.name))
    }
  })

  it('the preset holds exactly the capacity of every String column', () => {
    for (const [model, fields] of models(mysql)) {
      const strings = fields.filter((f) => /^String\??$/.test(f.type))
      const preset = PRESET[model] ?? {}
      expect(Object.keys(preset).sort(), model).toEqual(strings.map((f) => f.name).sort())
      for (const f of strings) expect(preset[f.name], `${model}.${f.name}`).toEqual(capacity(f.attrs))
    }
  })
})
