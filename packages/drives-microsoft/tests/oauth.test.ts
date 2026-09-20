import { describe, expect, it } from 'vitest'
import { createDriveFetch } from '@basaltkit/drives'
import { microsoftDrive } from '../src/index.js'
import { CLIENT_ID, REDIRECT_URI, connect, harness, type Harness } from './helpers.js'

describe('Microsoft OAuth', () => {
  it('asks for an offline grant, PKCE and the declared scopes on the common endpoint', () => {
    const h = harness()
    const url = new URL(
      h.provider.authorization.authorizeUrl({
        redirectUri: REDIRECT_URI,
        state: 'signed-state',
        codeChallenge: 'challenge-value',
      }),
    )

    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('response_mode')).toBe('query')
    expect(url.searchParams.get('code_challenge')).toBe('challenge-value')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('signed-state')
    // Without this Entra ID issues an access token and no refresh token, and
    // the connection silently dies within the hour.
    expect(url.searchParams.get('scope')?.split(' ')).toContain('offline_access')
  })

  it('targets one Entra tenant when the app registration is single-tenant', () => {
    const provider = microsoftDrive({ clientId: CLIENT_ID, tenant: 'contoso.onmicrosoft.com' })
    const url = new URL(
      provider.authorization.authorizeUrl({ redirectUri: REDIRECT_URI, state: 's', codeChallenge: 'c' }),
    )
    expect(url.pathname).toBe('/contoso.onmicrosoft.com/oauth2/v2.0/authorize')
  })

  it('refuses a tenant that could reshape the authority URL', () => {
    expect(() => microsoftDrive({ clientId: CLIENT_ID, tenant: '../evil' })).toThrow(TypeError)
    expect(() => microsoftDrive({ clientId: CLIENT_ID, tenant: 'a/b' })).toThrow(TypeError)
  })

  it('adds offline_access when a caller forgets it, rather than failing after consent', () => {
    const h = harness()
    const url = new URL(
      h.provider.authorization.authorizeUrl({
        redirectUri: REDIRECT_URI,
        state: 's',
        codeChallenge: 'c',
        scopes: ['Files.Read.All', 'Sites.Read.All'],
      }),
    )
    expect(url.searchParams.get('scope')).toBe('offline_access Files.Read.All Sites.Read.All')
  })

  it('never fetches the consent host — only the token endpoint is on the allowlist', () => {
    const h = harness()
    expect(h.provider.allowedHosts).toEqual([
      'login.microsoftonline.com',
      'graph.microsoft.com',
      '.files.1drv.com',
      '.sharepoint.com',
      '.svc.ms',
    ])
    // Every content host is a `.suffix`: `.sharepoint.com` allows
    // `contoso-my.sharepoint.com` and refuses `evilsharepoint.com`.
    for (const host of h.provider.allowedHosts.slice(2)) expect(host.startsWith('.')).toBe(true)
  })

  it('exchanges a code for an offline grant and records the account', async () => {
    const h = harness()
    const connection = await connect(h)

    expect(connection.provider).toBe('microsoft')
    expect(connection.status).toBe('active')
    expect(connection.account?.id).toBe('ms-user-1')
    expect(connection.account?.email).toBe('finance@acme.test')
    const token = h.graph.requests.find((r) => r.url.includes('/oauth2/v2.0/token'))!
    expect(token.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(new URLSearchParams(token.body).get('code_verifier')).toBeTruthy()
    expect(new URLSearchParams(token.body).get('grant_type')).toBe('authorization_code')
  })

  it('refuses a grant that came back without a refresh token', async () => {
    // What Entra ID answers when `offline_access` was not consented to: an
    // access token, no refresh token, and a connection that is already broken.
    const h = harness({ server: { grantedScopes: 'User.Read Files.Read' } })
    await expect(connect(h)).rejects.toMatchObject({ code: 'DRIVE_AUTHORIZATION_INVALID' })
  })

  it('sends no `scope` on the code exchange — the code already names the consent', async () => {
    const h = harness()
    await connect(h)
    const exchange = h.graph.requests.find((r) => r.url.includes('/oauth2/v2.0/token'))!
    expect(new URLSearchParams(exchange.body).get('scope')).toBeNull()
  })
})

describe('refresh-token rotation (the thing Microsoft does and Dropbox does not)', () => {
  it('persists the rotated refresh token, and the next refresh uses the new one', async () => {
    const h = harness()
    const view = await connect(h)
    const before = (await h.store.find('default', view.id))!
    const firstIssued = h.graph.issuedRefreshTokens.at(-1)!

    // An hour on: the engine refreshes proactively, before the token expires.
    h.advance(60 * 60_000)
    await h.drives.listItems(view.id)

    const firstRefresh = h.graph.requests.filter((r) => r.url.includes('/oauth2/v2.0/token')).at(-1)!
    expect(new URLSearchParams(firstRefresh.body).get('grant_type')).toBe('refresh_token')
    expect(new URLSearchParams(firstRefresh.body).get('refresh_token')).toBe(firstIssued)
    const rotated = h.graph.issuedRefreshTokens.at(-1)!
    expect(rotated).not.toBe(firstIssued)

    const after = (await h.store.find('default', view.id))!
    expect(after.secret).not.toBe(before.secret)
    expect(after.revision).toBeGreaterThan(before.revision)

    // The rotated token really was persisted: the old one is dead at the
    // provider, so a second cycle can only work if the new one was stored.
    h.advance(60 * 60_000)
    await expect(h.drives.listItems(view.id)).resolves.toBeDefined()
    const secondRefresh = h.graph.requests.filter((r) => r.url.includes('/oauth2/v2.0/token')).at(-1)!
    expect(new URLSearchParams(secondRefresh.body).get('refresh_token')).toBe(rotated)
  })

  it('does not condemn a healthy connection when a concurrent worker won the rotation race', async () => {
    const h = harness()
    const view = await connect(h)
    // A second worker's view of the row, taken before anybody refreshed. Its
    // sealed refresh token is the one the winner is about to retire.
    const stale = (await h.store.find('default', view.id))!

    h.advance(60 * 60_000)
    // Worker A refreshes and rotates. Worker B's copy is now worthless.
    await h.drives.listItems(view.id)
    const winner = (await h.store.find('default', view.id))!
    expect(winner.revision).toBeGreaterThan(stale.revision)

    // Worker B now runs an operation against its stale connection. Entra ID
    // answers `invalid_grant` — byte for byte what a REVOKED grant answers —
    // and taking that at face value would mark a perfectly healthy connection
    // `invalid` and log the tenant out of their own drive, at random, under
    // load. The engine re-reads the row first and adopts the winner's tokens.
    const page = await h.drives.run(stale, (session, provider) => provider.list(session, {}))

    expect(page.items).toBeDefined()
    expect((await h.store.find('default', view.id))!.status).toBe('active')
    await expect(h.drives.listItems(view.id)).resolves.toBeDefined()
  })

  it('still fails closed when the grant really is gone', async () => {
    const h = harness()
    const view = await connect(h)
    h.graph.revokeGrant()
    h.advance(60 * 60_000)

    await expect(h.drives.listItems(view.id)).rejects.toMatchObject({ code: 'DRIVE_CREDENTIALS_INVALID' })
    expect((await h.store.find('default', view.id))!.status).toBe('invalid')
  })

  it('refreshes with the scopes the connection consented to, not the adapter defaults', async () => {
    const h = harness({ server: { grantedScopes: 'offline_access Files.Read.All Sites.Read.All' } })
    const view = await connect(h, { scopes: ['offline_access', 'Files.Read.All', 'Sites.Read.All'] })
    expect((await h.store.find('default', view.id))!.scopes).toContain('Sites.Read.All')

    h.advance(60 * 60_000)
    await h.drives.listItems(view.id)

    const refresh = h.graph.requests.filter((r) => r.url.includes('/oauth2/v2.0/token')).at(-1)!
    const scope = new URLSearchParams(refresh.body).get('scope')!.split(' ')
    // A refresh that quietly narrowed to `Files.Read` would keep working until
    // the first SharePoint call, which then fails as a permissions problem a
    // long way from the cause.
    expect(scope).toContain('Sites.Read.All')
    expect(scope).toContain('offline_access')
  })

  it('does not condemn the connection when the app itself is misconfigured', async () => {
    const h = harness({ provider: { clientId: 'wrong-client' } })
    // `invalid_client` is our deployment's mistake, not the tenant's
    // revocation. Treating it as terminal would log every tenant out of their
    // drive over one bad environment variable.
    await expect(
      h.provider.authorization.refresh({ refreshToken: 'refresh-1', fetch: fetchOf(h) }),
    ).rejects.not.toMatchObject({ code: 'DRIVE_CREDENTIALS_INVALID' })
  })
})

describe('revocation, which Microsoft does not have', () => {
  it('omits `revoke` entirely rather than pretending', () => {
    const h = harness()
    // The contract makes `revoke` optional precisely so an adapter can be
    // honest about a capability the vendor does not offer. Graph has no
    // per-application revoke: the user withdraws consent in their own account
    // portal.
    expect(h.provider.authorization.revoke).toBeUndefined()
  })

  it('disconnects locally, revokes nothing, and leaves no request behind claiming otherwise', async () => {
    const h = harness()
    const view = await connect(h)
    const before = h.graph.requests.length

    await h.drives.disconnect(view.id)

    // The row and its sealed credentials are gone…
    expect(await h.store.find('default', view.id)).toBeNull()
    // …and nothing that looks like a revoke ever went on the wire, because
    // there is no endpoint to call. `disconnect` therefore emits
    // `revoked: false`, which is what an operator needs in order to know the
    // grant may still be live at Microsoft.
    expect(h.graph.requests.slice(before).some((r) => /revoke|signOut/i.test(r.url))).toBe(false)
  })
})

describe('credential hygiene', () => {
  it('never lets a token reach a hook payload or a serialised connection', async () => {
    const h = harness()
    const view = await connect(h)
    const stored = (await h.store.find('default', view.id))!
    const serialised = JSON.stringify(view)

    expect(serialised).not.toContain('refresh-')
    expect(serialised).not.toContain('access-')
    expect(serialised).not.toContain(stored.secret)
  })
})

/** The guarded fetch a bare authorization call needs, built the same way the engine builds it. */
function fetchOf(h: Harness) {
  return createDriveFetch({
    allowedHosts: h.provider.allowedHosts,
    provider: 'microsoft',
    transport: h.graph.transport,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  })
}
