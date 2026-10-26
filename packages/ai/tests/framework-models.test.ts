import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FRAMEWORK_GLOBAL_MODELS } from '../src/doctor/rules.js'

const packagesDir = join(import.meta.dirname, '..', '..')

/** Every model a `-prisma` reference schema ships without a tenantId, with its @@map table. */
function untenantedReferenceModels(): Record<string, string> {
  const found: Record<string, string> = {}
  for (const dir of readdirSync(packagesDir).filter((name) => name.endsWith('-prisma'))) {
    let schema: string
    try {
      schema = readFileSync(join(packagesDir, dir, 'prisma', 'schema.prisma'), 'utf8').replace(/(^|\s)\/\/.*$/gm, '$1')
    } catch {
      continue
    }
    for (const [, name, body] of schema.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/gs)) {
      if (!name || body === undefined || /^\s*tenantId\s/m.test(body)) continue
      found[name] = /@@map\(\s*"([^"]+)"\s*\)/.exec(body)?.[1] ?? '(no @@map)'
    }
  }
  return found
}

describe('FRAMEWORK_GLOBAL_MODELS', () => {
  it('matches the untenanted models of the -prisma reference schemas', () => {
    expect({ ...FRAMEWORK_GLOBAL_MODELS }).toEqual(untenantedReferenceModels())
  })
})
