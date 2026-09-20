import { describe, expect, it } from 'vitest'
import { DriveCredentialsInvalidError } from '../src/errors.js'
import { connect, harness, TEST_KEYS, TEST_SECRET } from './helpers.js'

/** An hour and a minute: past the fake's 1h token lifetime and the 60s refresh skew. */
const PAST_EXPIRY = 61 * 60_000

describe('credentials', () => {
  it('uses the stored access token while it is valid', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    await h.drives.listItems(view.id, { tenantId: 'acme' })
    expect(h.fake.calls['refresh']).toBeUndefined()
  })

  it('refreshes before the token expires, not after it fails', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    await h.drives.listItems(view.id, { tenantId: 'acme' })
    const tokenBefore = h.fake.seenAccessTokens.at(-1)

    h.advance(PAST_EXPIRY)
    await h.drives.listItems(view.id, { tenantId: 'acme' })

    expect(h.fake.calls['refresh']).toBe(1)
    // The second call went out with a DIFFERENT token, which is the only proof
    // that the refresh took effect rather than merely being attempted.
    expect(h.fake.seenAccessTokens.at(-1)).not.toBe(tokenBefore)
  })

  it('persists the refreshed credentials', async () => {
    const h = harness()
    const view = await connect(h, { tenantId: 'acme' })
    const before = (await h.store.find('acme', view.id))!.secret

    h.advance(PAST_EXPIRY)
    await h.drives.listItems(view.id, { tenantId: 'acme' })

    const after = (await h.store.find('acme', view.id))!
    expect(after.secret).not.toBe(before)
    expect(after.revision).toBeGreaterThan(1)
  })

  describe('refresh-token rotation', () => {
    it('stores the new refresh token when the provider rotates it', async () => {
      const h = harness({ provider: { rotateRefreshTokens: true } })
      const view = await connect(h, { tenantId: 'acme' })

      h.advance(PAST_EXPIRY)
      await h.drives.listItems(view.id, { tenantId: 'acme' })
      // A second cycle only works if the FIRST rotation was persisted: the
      // fake retires a rotated token immediately, so reusing the original
      // would fail here.
      h.advance(PAST_EXPIRY)
      await h.drives.listItems(view.id, { tenantId: 'acme' })

      expect(h.fake.calls['refresh']).toBe(2)
    })

    it('keeps the existing refresh token when the provider omits one', async () => {
      // Google and Dropbox behaviour: refresh returns only a new access token.
      const h = harness({ provider: { rotateRefreshTokens: false } })
      const view = await connect(h, { tenantId: 'acme' })

      h.advance(PAST_EXPIRY)
      await h.drives.listItems(view.id, { tenantId: 'acme' })
      h.advance(PAST_EXPIRY)
      await h.drives.listItems(view.id, { tenantId: 'acme' })

      expect(h.fake.calls['refresh']).toBe(2)
    })
  })

  describe('single-flight', () => {
    it('refreshes once for many concurrent callers on the same connection', async () => {
      const h = harness()
      const view = await connect(h, { tenantId: 'acme' })
      h.advance(PAST_EXPIRY)

      await Promise.all(
        Array.from({ length: 10 }, () => h.drives.listItems(view.id, { tenantId: 'acme' })),
      )

      // Without single-flight this is 10 — and against a rotating provider,
      // nine of those would be spending an already-retired token.
      expect(h.fake.calls['refresh']).toBe(1)
      expect(h.fake.calls['list']).toBe(10)
    })

    it('refreshes each connection separately', async () => {
      const h = harness()
      const finance = await connect(h, { tenantId: 'acme', label: 'Finance' })
      const hr = await connect(h, { tenantId: 'acme', label: 'HR' })
      h.advance(PAST_EXPIRY)

      await Promise.all([
        h.drives.listItems(finance.id, { tenantId: 'acme' }),
        h.drives.listItems(hr.id, { tenantId: 'acme' }),
      ])
      expect(h.fake.calls['refresh']).toBe(2)
    })

    it('releases the in-flight slot after a failure, so a later call can retry', async () => {
      const h = harness()
      const view = await connect(h, { tenantId: 'acme' })
      h.advance(PAST_EXPIRY)
      h.fake.grantRevoked = true

      await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).rejects.toThrow(DriveCredentialsInvalidError)
      // A leaked in-flight promise would make this resolve with the FIRST
      // failure forever rather than re-evaluating the connection's state.
      await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).rejects.toThrow(DriveCredentialsInvalidError)
    })
  })

  describe('optimistic concurrency', () => {
    it('does not condemn a connection just because it lost a rotation race', async () => {
      // The nastiest real-world case, and the reason this branch exists.
      //
      // Two workers refresh the same connection at once against a provider
      // that ROTATES refresh tokens. The winner retires the shared token; the
      // loser's call then fails with `invalid_grant` — a response
      // indistinguishable from a genuinely revoked grant. Taking it at face
      // value marks a perfectly healthy connection `invalid` and logs the
      // tenant out of their own drive, at random, under load.
      const h = harness({ provider: { rotateRefreshTokens: true } })
      const view = await connect(h, { tenantId: 'acme' })
      h.advance(PAST_EXPIRY)

      const otherWorker = new (await import('../src/drives.js')).Drives({
        providers: [h.fake],
        keys: TEST_KEYS,
        secret: TEST_SECRET,
        store: h.store,
        now: h.now,
        retry: { attempts: 1 },
      })

      // Interleave precisely: the other worker completes a whole refresh in
      // the window between our unseal and our own call to the provider.
      const providerRefresh = h.fake.authorization.refresh.bind(h.fake.authorization)
      let raced = false
      h.fake.authorization.refresh = async (input) => {
        if (!raced) {
          raced = true
          await otherWorker.listItems(view.id, { tenantId: 'acme' })
        }
        return providerRefresh(input)
      }

      const before = (await h.store.find('acme', view.id))!.secret
      // We must still succeed, using the credentials the winner stored.
      await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).resolves.toBeDefined()

      const after = (await h.store.find('acme', view.id))!
      expect(raced).toBe(true)
      expect(after.status).toBe('active')
      expect(after.secret).not.toBe(before)
      // Two refresh attempts: the winner's, and ours that lost and recovered.
      expect(h.fake.calls['refresh']).toBe(2)
    })

    it('still condemns the connection when nobody else refreshed', async () => {
      // The control for the test above: with no competing writer, an
      // `invalid_grant` means exactly what it says.
      const h = harness({ provider: { rotateRefreshTokens: true } })
      const view = await connect(h, { tenantId: 'acme' })
      h.advance(PAST_EXPIRY)
      h.fake.grantRevoked = true

      await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).rejects.toThrow(DriveCredentialsInvalidError)
      expect((await h.store.find('acme', view.id))?.status).toBe('invalid')
    })
  })

  describe('invalid credentials — fail closed', () => {
    it('marks the connection invalid when the grant is gone', async () => {
      const h = harness()
      const view = await connect(h, { tenantId: 'acme' })
      h.advance(PAST_EXPIRY)
      h.fake.grantRevoked = true

      await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).rejects.toThrow(DriveCredentialsInvalidError)
      expect((await h.store.find('acme', view.id))?.status).toBe('invalid')
    })

    it('stops calling the provider once a connection is invalid', async () => {
      const h = harness()
      const view = await connect(h, { tenantId: 'acme' })
      h.advance(PAST_EXPIRY)
      h.fake.grantRevoked = true
      await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).rejects.toThrow()
      const refreshesSoFar = h.fake.calls['refresh']

      // An invalid connection must not generate provider traffic from every
      // queued job — that is how one broken tenant gets the whole app
      // throttled.
      await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).rejects.toThrow(DriveCredentialsInvalidError)
      await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).rejects.toThrow(DriveCredentialsInvalidError)
      expect(h.fake.calls['refresh']).toBe(refreshesSoFar)
    })

    it('never puts a token in the error', async () => {
      const h = harness()
      const view = await connect(h, { tenantId: 'acme' })
      h.advance(PAST_EXPIRY)
      h.fake.grantRevoked = true

      const error = await h.drives.listItems(view.id, { tenantId: 'acme' }).catch((e: unknown) => e)
      const serialised = JSON.stringify({
        message: (error as Error).message,
        details: (error as { details?: unknown }).details,
      })
      expect(serialised).not.toContain('refresh-')
      expect(serialised).not.toContain('access-')
    })

    it('invalidates when the access token expired and nothing can refresh it', async () => {
      const h = harness()
      const view = await h.drives.connect({
        provider: 'fake',
        label: 'No refresh token',
        tenantId: 'acme',
        tokens: { accessToken: 'access-orphan', expiresAt: h.now() + 1000 },
      })
      h.advance(PAST_EXPIRY)

      await expect(h.drives.listItems(view.id, { tenantId: 'acme' })).rejects.toThrow(DriveCredentialsInvalidError)
      expect((await h.store.find('acme', view.id))?.status).toBe('invalid')
      expect(h.fake.calls['refresh']).toBeUndefined()
    })
  })
})
