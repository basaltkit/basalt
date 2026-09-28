import { describe, expect, it } from 'vitest'
import { Drives } from '../src/drives.js'
import { DriveCredentialsInvalidError } from '../src/errors.js'
import { connect, harness, TEST_KEYS, TEST_SECRET, type Harness } from './helpers.js'

/** An hour and a minute: past the fake's 1h token lifetime and the 60s refresh skew. */
const PAST_EXPIRY = 61 * 60_000

/**
 * FA-074 — a refresh that loses to another worker must never condemn a healthy
 * connection. `invalidate()` used to write `status: 'invalid'` with no
 * `expectedRevision`, so it clobbered whatever a concurrent winner had stored
 * a moment earlier, and a winner that saved *after* the loser had invalidated
 * gave up instead of keeping the only live refresh token.
 */
function otherWorker(h: Harness): Drives {
  return new Drives({
    providers: [h.fake],
    keys: TEST_KEYS,
    secret: TEST_SECRET,
    store: h.store,
    now: h.now,
    retry: { attempts: 1 },
  })
}

describe('refresh race (FA-074)', () => {
  it('does not overwrite credentials a winner stored between our re-read and our invalidation', async () => {
    const h = harness({ provider: { rotateRefreshTokens: true } })
    const view = await connect(h, { tenantId: 'acme' })
    h.advance(PAST_EXPIRY)
    const winner = otherWorker(h)

    // Our refresh is told the grant is gone — exactly what a rotating provider
    // answers when another worker has just spent the same refresh token.
    const providerRefresh = h.fake.authorization.refresh.bind(h.fake.authorization)
    let ours = true
    h.fake.authorization.refresh = async (input) => {
      if (ours) {
        ours = false
        throw new DriveCredentialsInvalidError(view.id, 'invalid_grant')
      }
      return providerRefresh(input)
    }
    // …and the winner commits its fresh tokens in the window between our
    // re-read of the row and our write of `status: 'invalid'`.
    const update = h.store.update.bind(h.store)
    let raced = false
    h.store.update = async (tenantId, id, patch, expectedRevision) => {
      if (patch.status === 'invalid' && !raced) {
        raced = true
        await winner.listItems(view.id, { tenantId: 'acme' })
      }
      return update(tenantId, id, patch, expectedRevision)
    }

    await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).resolves.toBeDefined()
    expect(raced).toBe(true)
    expect((await h.store.find('acme', view.id))?.status).toBe('active')
    // And it keeps working: the stored refresh token is the live one.
    h.advance(PAST_EXPIRY)
    await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).resolves.toBeDefined()
  })

  it('a winner that saves after a loser invalidated restores the connection', async () => {
    const h = harness({ provider: { rotateRefreshTokens: true } })
    const view = await connect(h, { tenantId: 'acme' })
    h.advance(PAST_EXPIRY)
    const loser = otherWorker(h)

    // The winner (h.drives) spends the refresh token at the provider; before
    // it gets to store the result, the loser tries the same, now-retired token,
    // gets `invalid_grant`, sees nobody has written yet, and invalidates.
    const providerRefresh = h.fake.authorization.refresh.bind(h.fake.authorization)
    let first = true
    let loserOutcome: unknown
    h.fake.authorization.refresh = async (input) => {
      if (!first) return providerRefresh(input)
      first = false
      const fresh = await providerRefresh(input)
      loserOutcome = await loser.listItems(view.id, { tenantId: 'acme' }).catch((error: unknown) => error)
      return fresh
    }

    await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).resolves.toBeDefined()
    expect(loserOutcome).toBeInstanceOf(DriveCredentialsInvalidError)
    // The winner holds the only live refresh token in existence. Giving up
    // here would lose it for good and log the tenant out of their own drive.
    expect((await h.store.find('acme', view.id))?.status).toBe('active')
    h.advance(PAST_EXPIRY)
    await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).resolves.toBeDefined()
  })

  it('never resurrects a connection that was disconnected or re-consented meanwhile', async () => {
    const h = harness({ provider: { rotateRefreshTokens: true } })
    const view = await connect(h, { tenantId: 'acme' })
    h.advance(PAST_EXPIRY)

    const providerRefresh = h.fake.authorization.refresh.bind(h.fake.authorization)
    h.fake.authorization.refresh = async (input) => {
      const fresh = await providerRefresh(input)
      // Somebody marked the connection revoked while we were at the provider.
      await h.store.update('acme', view.id, { status: 'revoked' })
      return fresh
    }

    await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).rejects.toThrow(DriveCredentialsInvalidError)
    expect((await h.store.find('acme', view.id))?.status).toBe('revoked')
  })
})
