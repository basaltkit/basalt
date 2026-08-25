import { describe, expect, it, vi } from 'vitest'

// Zod 4 ships a native `z.toJSONSchema`, so `zodToJsonSchema` short-circuits to
// it and the hand-rolled Zod-v3 fallback `switch` never runs. To exercise that
// fallback (the single biggest branch gap in the file) we mock `zod` so the
// imported `z` has NO `toJSONSchema`, forcing the v3 path. We then feed
// hand-crafted `_def`-shaped objects — exactly what the v3 code reads — to drive
// every case deterministically, no Zod-v3 install required.
vi.mock('zod', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zod')>()
  const z = { ...actual.z, toJSONSchema: undefined }
  return { ...actual, z }
})

import { zodToJsonSchema } from '../src/openapi.js'

// Minimal fake ZodType: the v3 path only ever reads `._def`.
const fake = (def: Record<string, unknown>): never => ({ _def: def }) as never
const str = fake({ typeName: 'ZodString' })

describe('zodToJsonSchema — v3 fallback path (native converter absent)', () => {
  it('ZodString: every check kind (email/url/uuid/min/max/regex)', () => {
    expect(
      zodToJsonSchema(
        fake({
          typeName: 'ZodString',
          checks: [
            { kind: 'email' },
            { kind: 'url' },
            { kind: 'uuid' },
            { kind: 'min', value: 2 },
            { kind: 'max', value: 5 },
            { kind: 'regex', regex: /^a.+z$/ },
          ],
        }),
      ),
    ).toEqual({ type: 'string', format: 'uuid', minLength: 2, maxLength: 5, pattern: '^a.+z$' })
  })

  it('ZodString: individual formats resolve cleanly', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodString', checks: [{ kind: 'email' }] }))).toEqual({ type: 'string', format: 'email' })
    expect(zodToJsonSchema(fake({ typeName: 'ZodString', checks: [{ kind: 'url' }] }))).toEqual({ type: 'string', format: 'uri' })
  })

  it('ZodString: no checks array falls back to []', () => {
    expect(zodToJsonSchema(str)).toEqual({ type: 'string' })
  })

  it('ZodString: a regex check with no regex object stringifies undefined', () => {
    // Exercises the `check.regex?.source` optional-chain undefined branch.
    expect(zodToJsonSchema(fake({ typeName: 'ZodString', checks: [{ kind: 'regex' }] }))).toEqual({ type: 'string', pattern: 'undefined' })
  })

  it('ZodString: an unrecognised check kind is ignored', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodString', checks: [{ kind: 'startsWith', value: 'a' }] }))).toEqual({ type: 'string' })
  })

  it('ZodNumber: int/min/max checks', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodNumber', checks: [{ kind: 'int' }, { kind: 'min', value: 1 }, { kind: 'max', value: 10 }] }))).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 10,
    })
  })

  it('ZodNumber: no checks stays a plain number', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodNumber' }))).toEqual({ type: 'number' })
  })

  it('ZodNumber: an unrecognised check kind is ignored', () => {
    // Falls through the int/min/max chain (the trailing else-if false branch).
    expect(zodToJsonSchema(fake({ typeName: 'ZodNumber', checks: [{ kind: 'finite' }] }))).toEqual({ type: 'number' })
  })

  it('ZodBoolean', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodBoolean' }))).toEqual({ type: 'boolean' })
  })

  it('ZodDate (via the switch, not the instanceof shortcut)', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodDate' }))).toEqual({ type: 'string', format: 'date-time' })
  })

  it('ZodLiteral', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodLiteral', value: 42 }))).toEqual({ const: 42 })
  })

  it('ZodEnum', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodEnum', values: ['a', 'b'] }))).toEqual({ type: 'string', enum: ['a', 'b'] })
  })

  it('ZodNativeEnum', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodNativeEnum', values: { Admin: 'admin', User: 'user' } }))).toEqual({ enum: ['admin', 'user'] })
  })

  it('ZodArray recurses into items', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodArray', type: str }))).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('ZodObject: required vs optional vs default fields', () => {
    const out = zodToJsonSchema(
      fake({
        typeName: 'ZodObject',
        shape: () => ({
          req: str,
          opt: fake({ typeName: 'ZodOptional', innerType: str }),
          def: fake({ typeName: 'ZodDefault', innerType: str, defaultValue: () => 'd' }),
        }),
      }),
    )
    expect(out).toMatchObject({ type: 'object' })
    // `opt` (ZodOptional) and `def` (ZodDefault) are both treated as optional; only `req` is required.
    expect((out as { required: string[] }).required).toEqual(['req'])
  })

  it('ZodObject: all-optional shape omits `required`', () => {
    const out = zodToJsonSchema(
      fake({ typeName: 'ZodObject', shape: () => ({ opt: fake({ typeName: 'ZodOptional', innerType: str }) }) }),
    )
    expect(out).toEqual({ type: 'object', properties: { opt: { type: 'string' } } })
    expect(out).not.toHaveProperty('required')
  })

  it('ZodOptional unwraps without adding nullable', () => {
    const out = zodToJsonSchema(fake({ typeName: 'ZodOptional', innerType: str }))
    expect(out).toEqual({ type: 'string' })
    expect(out).not.toHaveProperty('nullable')
  })

  it('ZodNullable adds nullable:true', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodNullable', innerType: str }))).toEqual({ type: 'string', nullable: true })
  })

  it('ZodDefault carries the resolved default value', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodDefault', innerType: str, defaultValue: () => 'hello' }))).toEqual({
      type: 'string',
      default: 'hello',
    })
  })

  it('ZodEffects unwraps its inner schema', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodEffects', schema: str }))).toEqual({ type: 'string' })
  })

  it('ZodUnion maps options to anyOf', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodUnion', options: [str, fake({ typeName: 'ZodBoolean' })] }))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'boolean' }],
    })
  })

  it('ZodRecord maps to additionalProperties', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodRecord', valueType: fake({ typeName: 'ZodNumber' }) }))).toEqual({
      type: 'object',
      additionalProperties: { type: 'number' },
    })
  })

  it('an unknown typeName degrades to {}', () => {
    expect(zodToJsonSchema(fake({ typeName: 'ZodSomethingNew' }))).toEqual({})
  })

  it('a value with no _def degrades to {}', () => {
    expect(zodToJsonSchema({} as never)).toEqual({})
    expect(zodToJsonSchema(null as never)).toEqual({})
  })
})
