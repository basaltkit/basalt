import { describe, expect, it } from 'vitest'
import { PrismaUserSource } from '../src/index.js'
import { makeFakeClient } from './fake-client.js'

/** BK-045: `create({ emailVerified })` persists the flag with the row. */
describe('PrismaUserSource.create emailVerified', () => {
  it('persists emailVerified: true at create time and round-trips it', async () => {
    const source = new PrismaUserSource(makeFakeClient())
    const created = await source.create({ email: 'V@acme.test', passwordHash: 'h', emailVerified: true })
    expect(created.emailVerified).toBe(true)
    expect((await source.findById(created.id))?.emailVerified).toBe(true)
    expect((await source.findByEmail('v@acme.test'))?.emailVerified).toBe(true)
  })

  it('defaults to false when omitted', async () => {
    const source = new PrismaUserSource(makeFakeClient())
    const created = await source.create({ email: 'u@acme.test', passwordHash: 'h' })
    expect(created.emailVerified).toBe(false)
    expect((await source.findById(created.id))?.emailVerified).toBe(false)
  })
})
