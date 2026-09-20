import { describe, expect, it } from 'vitest'
import { CLIENT_ID, REDIRECT_URI, connect, harness } from './helpers.js'

describe('Google OAuth', () => {
  it('asks for an offline grant, a fresh consent, PKCE and the declared scopes', () => {
    const h = harness()
    const url = new URL(
      h.provider.authorization.authorizeUrl({
        redirectUri: REDIRECT_URI,
        state: 'signed-state',
        codeChallenge: 'challenge-value',
      }),
    )

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    // Without this Google issues an hour-long grant and no refresh token.
    expect(url.searchParams.get('access_type')).toBe('offline')
    // And without THIS, a user who already consented once gets no refresh
    // token on any later connect — the failure mode that only shows up on the
    // second connection a tenant makes.
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('signed-state')
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/drive.readonly')
  })

  it('never fetches the consent host — it is not even on the allowlist', () => {
    const h = harness()
    expect(h.provider.allowedHosts).not.toContain('accounts.google.com')
    expect(h.provider.allowedHosts).toEqual([
      'www.googleapis.com',
      'oauth2.googleapis.com',
      // A leading-dot suffix: subdomains only, never the bare parent, and
      // never `evilgoogleusercontent.com`.
      '.googleusercontent.com',
    ])
  })

  it('exchanges a code for an offline grant and records the account', async () => {
    const h = harness()
    const connection = await connect(h)

    expect(connection.provider).toBe('google')
    expect(connection.status).toBe('active')
    // `about.get`, not the userinfo endpoint: no extra scope is needed.
    expect(connection.account?.id).toBe('1122334455')
    expect(connection.account?.email).toBe('finance@acme.test')
    const token = h.google.requests.find((r) => r.url.includes('/token'))!
    expect(token.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(new URLSearchParams(token.body).get('code_verifier')).toBeTruthy()
    expect(new URLSearchParams(token.body).get('grant_type')).toBe('authorization_code')
  })

  it('refuses a grant that came back without a refresh token', async () => {
    const h = harness()
    // What Google answers when the user had already consented and the
    // authorization did not force a new one.
    h.google.queue(200, JSON.stringify({ access_token: 'a', expires_in: 3599, token_type: 'Bearer' }))
    // Better to refuse the connect than to create a connection that works for
    // an hour and then has no way back.
    await expect(connect(h)).rejects.toMatchObject({ code: 'DRIVE_AUTHORIZATION_INVALID' })
  })

  it('refreshes proactively and keeps the stored refresh token (Google does not rotate)', async () => {
    const h = harness({ server: { files: [{ id: 'f1', name: 'a.pdf', content: 'a' }] } })
    const view = await connect(h)
    const before = (await h.store.find('default', view.id))!

    // An hour on: the engine refreshes before the token expires, not after a 401.
    h.advance(60 * 60_000)
    await h.drives.listItems(view.id)

    const refresh = h.google.requests.filter((r) => r.url.includes('/token')).at(-1)!
    expect(new URLSearchParams(refresh.body).get('grant_type')).toBe('refresh_token')
    expect(new URLSearchParams(refresh.body).get('refresh_token')).toBe('refresh-1')
    const after = (await h.store.find('default', view.id))!
    // The credentials were re-sealed, so the row changed…
    expect(after.secret).not.toBe(before.secret)
    // …and the refresh token survived, because the response omitted one.
    h.advance(60 * 60_000)
    await expect(h.drives.listItems(view.id)).resolves.toBeDefined()
  })

  it('treats invalid_grant as terminal and marks the connection invalid', async () => {
    const h = harness()
    const view = await connect(h)
    // Revoked from the Google account's "third-party access" page — or, and
    // this is the uncomfortable part, simply unused for six months. Google
    // answers `invalid_grant` for both and the contract cannot tell them apart.
    h.google.revokeGrant()
    h.advance(60 * 60_000)

    await expect(h.drives.listItems(view.id)).rejects.toMatchObject({ code: 'DRIVE_CREDENTIALS_INVALID' })
    expect((await h.store.find('default', view.id))!.status).toBe('invalid')
  })

  it('does not treat OUR misconfiguration as the tenant’s revocation', async () => {
    const h = harness()
    const view = await connect(h)
    h.advance(60 * 60_000)
    // `invalid_client` is a deployment mistake. Mapping it to
    // DRIVE_CREDENTIALS_INVALID would log every tenant out of their drive
    // because someone rotated a client secret.
    h.google.queue(400, JSON.stringify({ error: 'invalid_client' }))

    await expect(h.drives.listItems(view.id)).rejects.toThrow(/token refresh failed \(invalid_client\)/)
    expect((await h.store.find('default', view.id))!.status).toBe('active')
  })

  it('revokes the refresh token, not just the access token, on disconnect', async () => {
    const h = harness()
    const view = await connect(h)

    await h.drives.disconnect(view.id)

    const revoke = h.google.requests.find((r) => r.url.includes('/revoke'))!
    // Revoking the access token alone would leave the grant alive and merely
    // make the remaining access invisible to us.
    expect(new URLSearchParams(revoke.body).get('token')).toBe('refresh-1')
    expect(await h.store.find('default', view.id)).toBeNull()
  })

  it('sends the token request through the guarded fetch, like every other call', async () => {
    const h = harness()
    await connect(h)
    const token = h.google.requests.find((r) => r.url.includes('/token'))!
    // A token exchange is as much an SSRF and timeout surface as a download,
    // and it is the one call that carries the client secret.
    expect(token.url.startsWith('https://oauth2.googleapis.com/')).toBe(true)
    expect(new URLSearchParams(token.body).get('client_secret')).toBe('client-secret')
  })
})
