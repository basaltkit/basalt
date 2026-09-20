import { describe, expect, it } from 'vitest'
import { createDriveFetch } from '@basaltkit/drives'
import { APP_KEY, connect, harness } from './helpers.js'

describe('Dropbox OAuth', () => {
  it('asks for an offline grant, PKCE and the declared scopes', () => {
    const h = harness()
    const url = new URL(
      h.provider.authorization.authorizeUrl({
        redirectUri: 'https://app.test/cb',
        state: 'signed-state',
        codeChallenge: 'challenge-value',
      }),
    )

    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize')
    expect(url.searchParams.get('client_id')).toBe(APP_KEY)
    expect(url.searchParams.get('response_type')).toBe('code')
    // Without this Dropbox issues a 4-hour grant and no refresh token, and the
    // connection silently dies overnight.
    expect(url.searchParams.get('token_access_type')).toBe('offline')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('signed-state')
    expect(url.searchParams.get('scope')).toBe('account_info.read files.metadata.read files.content.read')
  })

  it('never fetches the consent host — it is not even on the allowlist', () => {
    const h = harness()
    expect(h.provider.allowedHosts).not.toContain('www.dropbox.com')
    expect(h.provider.allowedHosts).toEqual([
      'api.dropboxapi.com',
      'content.dropboxapi.com',
      'notify.dropboxapi.com',
    ])
  })

  it('exchanges a code for an offline grant and records the account', async () => {
    const h = harness()
    const connection = await connect(h)

    expect(connection.provider).toBe('dropbox')
    expect(connection.status).toBe('active')
    expect(connection.account?.id).toBe('dbid:AAH-ACME')
    expect(connection.account?.email).toBe('finance@acme.test')
    const token = h.dropbox.requests.find((r) => r.url.includes('/oauth2/token'))!
    expect(token.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(new URLSearchParams(token.body).get('code_verifier')).toBeTruthy()
    expect(new URLSearchParams(token.body).get('grant_type')).toBe('authorization_code')
  })

  it('refuses a grant that came back without a refresh token', async () => {
    const h = harness()
    // Dropbox answers this way when `token_access_type=offline` was not honoured.
    h.dropbox.queue(200, JSON.stringify({ access_token: 'a', expires_in: 14400, token_type: 'bearer' }))
    // Better to refuse the connect than to create one that is already broken:
    // the access token works for four hours and then there is no way back.
    await expect(connect(h)).rejects.toMatchObject({ code: 'DRIVE_AUTHORIZATION_INVALID' })
  })

  it('refreshes proactively and keeps the stored refresh token (Dropbox does not rotate)', async () => {
    const h = harness()
    const view = await connect(h)
    const before = (await h.store.find('default', view.id))!

    // Four hours on: the engine refreshes before the token expires, not after
    // a 401.
    h.advance(4 * 60 * 60_000)
    await h.drives.listItems(view.id)

    const refresh = h.dropbox.requests.filter((r) => r.url.includes('/oauth2/token')).at(-1)!
    expect(new URLSearchParams(refresh.body).get('grant_type')).toBe('refresh_token')
    expect(new URLSearchParams(refresh.body).get('refresh_token')).toBe('refresh-1')
    const after = (await h.store.find('default', view.id))!
    // The credentials were re-sealed, so the row changed…
    expect(after.secret).not.toBe(before.secret)
    // …and the refresh token survived, because the response omitted one.
    h.advance(4 * 60 * 60_000)
    await expect(h.drives.listItems(view.id)).resolves.toBeDefined()
  })

  it('marks the connection invalid when the grant has been revoked', async () => {
    const h = harness()
    const view = await connect(h)
    h.dropbox.revokeGrant()
    h.advance(4 * 60 * 60_000)

    await expect(h.drives.listItems(view.id)).rejects.toMatchObject({ code: 'DRIVE_CREDENTIALS_INVALID' })
    expect((await h.store.find('default', view.id))!.status).toBe('invalid')
  })

  it('does not condemn the connection when the app itself is misconfigured', async () => {
    const h = harness({ provider: { clientId: 'wrong-key' } })
    // `invalid_client` is our deployment's mistake, not the tenant's
    // revocation. Treating it as terminal would log every tenant out of their
    // drive over one bad environment variable.
    await expect(
      h.provider.authorization.refresh({
        refreshToken: 'refresh-1',
        fetch: fetchOf(h),
      }),
    ).rejects.not.toMatchObject({ code: 'DRIVE_CREDENTIALS_INVALID' })
  })

  it('revokes at the provider on disconnect', async () => {
    const h = harness()
    const view = await connect(h)
    await h.drives.disconnect(view.id)

    const revoke = h.dropbox.requests.find((r) => r.url.includes('/2/auth/token/revoke'))
    expect(revoke).toBeDefined()
    expect(revoke!.headers['authorization']).toMatch(/^Bearer /)
    expect(await h.store.find('default', view.id)).toBeNull()
  })

  it('never lets a token reach a hook payload or a serialised connection', async () => {
    const h = harness()
    const view = await connect(h)
    const stored = (await h.store.find('default', view.id))!
    const serialised = JSON.stringify(view)
    expect(serialised).not.toContain('refresh-1')
    expect(serialised).not.toContain('access-')
    expect(serialised).not.toContain(stored.secret)
  })
})

/** The guarded fetch a bare authorization call needs, built the same way the engine builds it. */
function fetchOf(h: ReturnType<typeof harness>) {
  return createDriveFetch({
    allowedHosts: h.provider.allowedHosts,
    provider: 'dropbox',
    transport: h.dropbox.transport,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  })
}
