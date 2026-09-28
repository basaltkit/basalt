import { describe, expect, it } from 'vitest'
import { createApp, ctx, runWithContext } from '@basaltkit/core'
import { db, DbUnavailableError, prismaPlugin } from '../src/index.js'

// FA-070 / D4: `tenancy.run(B)` copies the surrounding context — including the
// outer tenant's `db`. When the plugin has no client for B, it left that
// `db` in place, so B's writes landed in A's database. It must fail closed.
describe('tenancy:switched without a client for the new tenant (FA-070/D4)', () => {
  it('clears the inherited ctx.db instead of keeping the outer tenant client', async () => {
    const clientA = { name: 'db-of-a' }
    const app = await createApp({
      plugins: [prismaPlugin({ resolveClient: (id) => (id === 'a' ? clientA : undefined) })],
    }).boot()

    await runWithContext({ tenant: { id: 'a' }, db: clientA }, async () => {
      // what tenancy.run('b', fn) does: copy the context, switch the tenant
      await runWithContext({ ...ctx(), tenant: { id: 'b' } }, async () => {
        await app.hooks.emit('tenancy:switched', { tenant: { id: 'b' } } as never)
        expect(ctx().db).toBeUndefined()
        expect(() => db()).toThrowError(DbUnavailableError)
      })
      expect(ctx().db).toBe(clientA) // the outer context is untouched
    })
    await app.shutdown()
  })
})
