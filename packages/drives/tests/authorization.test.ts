import { describe, expect, it } from 'vitest'
import { DriveAuthorizationFlow, assertRedirectUri, challengeFor } from '../src/authorization.js'
import { DriveAuthorizationInvalidError } from '../src/errors.js'
import { connect, harness } from './helpers.js'

const REDIRECT = 'https://app.test/drives/callback'

const flowAt = (now: () => number = Date.now) => new DriveAuthorizationFlow('a-sufficiently-long-secret', { now })

describe('DriveAuthorizationFlow', () => {
  it('round-trips a state bound to the browser that started it', () => {
    const flow = flowAt()
    const started = flow.start({ provider: 'fake', tenantId: 'acme', redirectUri: REDIRECT })
    expect(() => flow.complete({ provider: 'fake', tenantId: 'acme', state: started.state, binding: started.binding })).not.toThrow()
  })

  it('derives a PKCE verifier that matches the challenge it advertised', () => {
    const flow = flowAt()
    const started = flow.start({ provider: 'fake', tenantId: 'acme', redirectUri: REDIRECT })
    const { codeVerifier } = flow.complete({
      provider: 'fake',
      tenantId: 'acme',
      state: started.state,
      binding: started.binding,
    })
    expect(challengeFor(codeVerifier)).toBe(started.codeChallenge)
  })

  describe('refuses what it should', () => {
    it('a callback with no binding (login CSRF — the attacker has the state, the victim has the cookie)', () => {
      const flow = flowAt()
      const started = flow.start({ provider: 'fake', tenantId: 'acme', redirectUri: REDIRECT })
      expect(() =>
        flow.complete({ provider: 'fake', tenantId: 'acme', state: started.state, binding: undefined }),
      ).toThrow(DriveAuthorizationInvalidError)
    })

    it('a callback with the wrong binding', () => {
      const flow = flowAt()
      const started = flow.start({ provider: 'fake', tenantId: 'acme', redirectUri: REDIRECT })
      expect(() =>
        flow.complete({ provider: 'fake', tenantId: 'acme', state: started.state, binding: 'someone-elses' }),
      ).toThrow(DriveAuthorizationInvalidError)
    })

    it('a state replayed a second time', () => {
      const flow = flowAt()
      const started = flow.start({ provider: 'fake', tenantId: 'acme', redirectUri: REDIRECT })
      flow.complete({ provider: 'fake', tenantId: 'acme', state: started.state, binding: started.binding })
      expect(() =>
        flow.complete({ provider: 'fake', tenantId: 'acme', state: started.state, binding: started.binding }),
      ).toThrow(/already used/)
    })

    it('a state replayed into ANOTHER tenant', () => {
      const flow = flowAt()
      const started = flow.start({ provider: 'fake', tenantId: 'acme', redirectUri: REDIRECT })
      expect(() =>
        flow.complete({ provider: 'fake', tenantId: 'globex', state: started.state, binding: started.binding }),
      ).toThrow(/tenant/)
    })

    it('a state replayed onto another provider', () => {
      const flow = flowAt()
      const started = flow.start({ provider: 'fake', tenantId: 'acme', redirectUri: REDIRECT })
      expect(() =>
        flow.complete({ provider: 'other', tenantId: 'acme', state: started.state, binding: started.binding }),
      ).toThrow(/provider/)
    })

    it('an expired state', () => {
      let clock = 1_000_000
      const flow = flowAt(() => clock)
      const started = flow.start({ provider: 'fake', tenantId: 'acme', redirectUri: REDIRECT })
      clock += 11 * 60_000
      expect(() =>
        flow.complete({ provider: 'fake', tenantId: 'acme', state: started.state, binding: started.binding }),
      ).toThrow(/expired/)
    })

    it('a state signed with a different secret', () => {
      const started = flowAt().start({ provider: 'fake', tenantId: 'acme', redirectUri: REDIRECT })
      const other = new DriveAuthorizationFlow('a-completely-different-secret')
      expect(() =>
        other.complete({ provider: 'fake', tenantId: 'acme', state: started.state, binding: started.binding }),
      ).toThrow(/signature/)
    })

    it('a tampered state payload', () => {
      const flow = flowAt()
      const started = flow.start({ provider: 'fake', tenantId: 'acme', redirectUri: REDIRECT })
      const [body, signature] = started.state.split('.')
      const forged = Buffer.from(
        JSON.stringify({ ...JSON.parse(Buffer.from(body as string, 'base64url').toString()), t: 'globex' }),
      ).toString('base64url')
      expect(() =>
        flow.complete({ provider: 'fake', tenantId: 'globex', state: `${forged}.${signature}`, binding: started.binding }),
      ).toThrow(/signature/)
    })

    it('a missing or malformed state', () => {
      const flow = flowAt()
      expect(() => flow.complete({ provider: 'fake', tenantId: 'acme', state: undefined, binding: 'b' })).toThrow()
      expect(() => flow.complete({ provider: 'fake', tenantId: 'acme', state: 'nodot', binding: 'b' })).toThrow()
    })
  })

  it('refuses a signing secret too short to be one', () => {
    expect(() => new DriveAuthorizationFlow('short')).toThrow(DriveAuthorizationInvalidError)
  })

  it('issues a distinct binding and state per flow', () => {
    const flow = flowAt()
    const a = flow.start({ provider: 'fake', tenantId: 'acme', redirectUri: REDIRECT })
    const b = flow.start({ provider: 'fake', tenantId: 'acme', redirectUri: REDIRECT })
    expect(a.binding).not.toBe(b.binding)
    expect(a.state).not.toBe(b.state)
    expect(a.codeChallenge).not.toBe(b.codeChallenge)
  })
})

describe('assertRedirectUri', () => {
  it('accepts https', () => {
    expect(() => assertRedirectUri('https://app.test/cb')).not.toThrow()
  })

  it('accepts http on localhost for development', () => {
    expect(() => assertRedirectUri('http://localhost:3000/cb')).not.toThrow()
    expect(() => assertRedirectUri('http://127.0.0.1:3000/cb')).not.toThrow()
  })

  it('refuses plain http elsewhere', () => {
    expect(() => assertRedirectUri('http://app.test/cb')).toThrow(DriveAuthorizationInvalidError)
  })

  it('refuses a non-absolute URL', () => {
    expect(() => assertRedirectUri('/cb')).toThrow(DriveAuthorizationInvalidError)
  })

  it('refuses embedded credentials and fragments', () => {
    // Built at runtime so secret scanners do not flag this fake credential.
    const withCredentials = ['https://user', 'pass@app.test/cb'].join(':')
    expect(() => assertRedirectUri(withCredentials)).toThrow(/credentials/)
    expect(() => assertRedirectUri('https://app.test/cb#x')).toThrow(/fragment/)
  })

  it('refuses a javascript: URI', () => {
    expect(() => assertRedirectUri('javascript:alert(1)')).toThrow(DriveAuthorizationInvalidError)
  })
})

describe('Drives.startAuthorization / completeAuthorization', () => {
  it('builds a consent URL carrying state and the PKCE challenge', async () => {
    const h = harness()
    const started = h.drives.startAuthorization({ provider: 'fake', redirectUri: REDIRECT, tenantId: 'acme' })
    const url = new URL(started.url)

    expect(url.searchParams.get('state')).toBe(started.state)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(started.binding).toBeTruthy()
  })

  it('validates the redirect URI before building the URL', () => {
    const h = harness()
    expect(() =>
      h.drives.startAuthorization({ provider: 'fake', redirectUri: 'http://evil.test/cb', tenantId: 'acme' }),
    ).toThrow(DriveAuthorizationInvalidError)
  })

  it('completes into a stored connection', async () => {
    const h = harness()
    const started = h.drives.startAuthorization({ provider: 'fake', redirectUri: REDIRECT, tenantId: 'acme' })
    const view = await h.drives.completeAuthorization({
      provider: 'fake',
      code: 'good-code',
      redirectUri: REDIRECT,
      state: started.state,
      binding: started.binding,
      label: 'Drive Finance',
      tenantId: 'acme',
    })

    expect(view.label).toBe('Drive Finance')
    expect(view.status).toBe('active')
    expect((await h.store.find('acme', view.id))?.secret).toMatch(/^bkd1\./)
  })

  it('refuses a callback whose binding does not match', async () => {
    const h = harness()
    const started = h.drives.startAuthorization({ provider: 'fake', redirectUri: REDIRECT, tenantId: 'acme' })
    await expect(
      h.drives.completeAuthorization({
        provider: 'fake',
        code: 'good-code',
        redirectUri: REDIRECT,
        state: started.state,
        binding: 'forged',
        label: 'x',
        tenantId: 'acme',
      }),
    ).rejects.toThrow(DriveAuthorizationInvalidError)
    expect(await h.drives.list({ tenantId: 'acme' })).toHaveLength(0)
  })

  it('lets one tenant hold two connections to the same provider', async () => {
    const h = harness()
    for (const label of ['Drive Finance', 'Drive HR']) {
      const started = h.drives.startAuthorization({ provider: 'fake', redirectUri: REDIRECT, tenantId: 'acme' })
      await h.drives.completeAuthorization({
        provider: 'fake',
        code: 'good-code',
        redirectUri: REDIRECT,
        state: started.state,
        binding: started.binding,
        label,
        tenantId: 'acme',
      })
    }
    // Sorted: the harness freezes the clock, so both rows share a createdAt
    // and the store falls back to its id tiebreak.
    expect((await h.drives.list({ tenantId: 'acme' })).map((c) => c.label).sort()).toEqual([
      'Drive Finance',
      'Drive HR',
    ])
  })

  it('does not create a connection when the code exchange fails', async () => {
    const h = harness()
    const started = h.drives.startAuthorization({ provider: 'fake', redirectUri: REDIRECT, tenantId: 'acme' })
    await expect(
      h.drives.completeAuthorization({
        provider: 'fake',
        code: 'bad-code',
        redirectUri: REDIRECT,
        state: started.state,
        binding: started.binding,
        label: 'x',
        tenantId: 'acme',
      }),
    ).rejects.toThrow()
    expect(await h.drives.list({ tenantId: 'acme' })).toHaveLength(0)
  })
})

describe('provider capability probing', () => {
  it('reports an unsupported capability rather than doing nothing', async () => {
    const h = harness({ provider: { supportsUpload: false } })
    const view = await connect(h, { tenantId: 'acme' })
    await expect(
      h.drives.upload(view.id, {
        name: 'x.txt',
        contentType: 'text/plain',
        content: (await import('node:stream')).Readable.from(['x']),
      }, { tenantId: 'acme' }),
    ).rejects.toMatchObject({ code: 'DRIVE_UNSUPPORTED' })
  })

  it('supports upload when the adapter offers it', async () => {
    const h = harness({ provider: { supportsUpload: true } })
    const view = await connect(h, { tenantId: 'acme' })
    const item = await h.drives.upload(view.id, {
      name: 'written.txt',
      contentType: 'text/plain',
      content: (await import('node:stream')).Readable.from(['hello']),
    }, { tenantId: 'acme' })
    expect(item.name).toBe('written.txt')
  })
})
