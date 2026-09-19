import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Auth, MemoryUserSource } from '@basaltkit/auth'
import {
  assertSafeNodeSamlVersion,
  extractEmail,
  Saml,
  SamlProviderConfigError,
  SamlProviderUnknownError,
  SamlResponseInvalidError,
  type SamlClient,
  type SamlProvider,
  samlClientConfig,
} from '../src/index.js'

const SECRET = 'x'.repeat(32)
const provider: SamlProvider = {
  name: 'okta',
  entryPoint: 'https://idp.test/sso',
  idpCert: 'CERT',
  issuer: 'my-sp',
  callbackUrl: 'https://app/acs',
}

const makeAuth = () => new Auth({ users: new MemoryUserSource(), secret: SECRET })

function fakeClient(overrides: Partial<SamlClient> = {}): SamlClient {
  return {
    async getAuthorizeUrlAsync(relayState) {
      return `https://idp.test/sso?SAMLRequest=req&RelayState=${relayState}`
    },
    async validatePostResponseAsync() {
      return { profile: { nameID: 'u1', email: 'saml@corp.com' }, loggedOut: false }
    },
    generateServiceProviderMetadata() {
      return '<EntityDescriptor entityID="my-sp"/>'
    },
    ...overrides,
  }
}

const makeSaml = (auth: Auth, client: SamlClient) => new Saml(auth, [provider], { createClient: () => client })

describe('Saml', () => {
  it('loginUrl delegates to the client (SP-initiated redirect)', async () => {
    const saml = makeSaml(makeAuth(), fakeClient())
    expect(await saml.loginUrl('okta', 'r1')).toContain('RelayState=r1')
  })

  it('consume validates the assertion and logs the user in by email', async () => {
    const auth = makeAuth()
    const r = await makeSaml(auth, fakeClient()).consume('okta', { SAMLResponse: 'b64' })
    expect(r.created).toBe(true)
    expect(r.user.email).toBe('saml@corp.com')
    expect((await auth.verifyAccessToken(r.tokens.accessToken)).sub).toBeTruthy()
  })

  it('does not create a duplicate for an existing user', async () => {
    const auth = makeAuth()
    await auth.register('saml@corp.com', 'password123')
    const r = await makeSaml(auth, fakeClient()).consume('okta', { SAMLResponse: 'b64' })
    expect(r.created).toBe(false)
  })

  it('rejects an unvalidated (null profile) assertion', async () => {
    const client = fakeClient({ async validatePostResponseAsync() { return { profile: null, loggedOut: false } } })
    await expect(makeSaml(makeAuth(), client).consume('okta', { SAMLResponse: 'x' })).rejects.toBeInstanceOf(
      SamlResponseInvalidError,
    )
  })

  it('rejects an assertion with no email', async () => {
    const client = fakeClient({ async validatePostResponseAsync() { return { profile: { nameID: 'u1' }, loggedOut: false } } })
    await expect(makeSaml(makeAuth(), client).consume('okta', { SAMLResponse: 'x' })).rejects.toBeInstanceOf(
      SamlResponseInvalidError,
    )
  })

  it('metadata returns the SP descriptor; unknown provider throws', () => {
    const saml = makeSaml(makeAuth(), fakeClient())
    expect(saml.metadata('okta')).toContain('EntityDescriptor')
    expect(() => saml.metadata('nope')).toThrow(SamlProviderUnknownError)
  })
})

describe('extractEmail', () => {
  it('reads the email attribute, common claims, or an email-shaped NameID', () => {
    expect(extractEmail({ email: 'a@x.com' })).toBe('a@x.com')
    expect(extractEmail({ 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress': 'b@x.com' })).toBe('b@x.com')
    expect(extractEmail({ nameID: 'c@x.com' })).toBe('c@x.com')
    expect(extractEmail({ nameID: 'not-an-email' })).toBeUndefined()
    expect(extractEmail({ department: 'd@x.com' }, 'department')).toBe('d@x.com')
  })
})

describe('F-2 · SAML assertion replay protection', () => {
  const provider = {
    name: 'idp',
    entryPoint: 'https://idp.example/sso',
    idpCert: 'CERT',
    issuer: 'https://sp.example',
    callbackUrl: 'https://sp.example/auth/saml/idp/callback',
  }

  it('binds the response to an AuthnRequest by default (node-saml defaults to never)', () => {
    expect(samlClientConfig(provider)['validateInResponseTo']).toBe('always')
  })

  it('still requires signed assertions', () => {
    expect(samlClientConfig(provider)['wantAssertionsSigned']).toBe(true)
  })

  it('is an explicit, documented opt-out', () => {
    expect(samlClientConfig(provider, { validateInResponseTo: 'never' })['validateInResponseTo']).toBe('never')
  })

  it('accepts a shared cacheProvider for multi-replica deployments', () => {
    const cacheProvider = {
      saveAsync: async () => null,
      getAsync: async () => null,
      removeAsync: async () => null,
    }
    expect(samlClientConfig(provider, { cacheProvider })['cacheProvider']).toBe(cacheProvider)
  })

  it('omits cacheProvider when none is given (node-saml uses its in-process cache)', () => {
    expect('cacheProvider' in samlClientConfig(provider)).toBe(false)
  })
})

describe('F15b · SAML provider trust boundary (an IdP may only assert its own email domains)', () => {
  const acme: SamlProvider = { ...provider, name: 'acme', allowedEmailDomains: ['acme.com'] }
  const globex: SamlProvider = { ...provider, name: 'globex', allowedEmailDomains: ['globex.com'] }
  const asserting = (email: string) =>
    fakeClient({ async validatePostResponseAsync() { return { profile: { nameID: email, email }, loggedOut: false } } })

  it("rejects an assertion from one customer's IdP for another customer's email", async () => {
    const auth = makeAuth()
    const victim = await auth.register('ceo@acme.com', 'password123')
    const saml = new Saml(auth, [acme, globex], { createClient: () => asserting('ceo@acme.com') })
    await expect(saml.consume('globex', { SAMLResponse: 'x' })).rejects.toBeInstanceOf(SamlResponseInvalidError)
    // Case variants and a custom email attribute go through the same check.
    const upper = new Saml(auth, [acme, globex], { createClient: () => asserting('CEO@Acme.Com') })
    await expect(upper.consume('globex', { SAMLResponse: 'x' })).rejects.toBeInstanceOf(SamlResponseInvalidError)
    const viaAttr = new Saml(auth, [acme, { ...globex, emailAttribute: 'mail' }], {
      createClient: () =>
        fakeClient({
          async validatePostResponseAsync() {
            return { profile: { nameID: 'x@globex.com', mail: 'ceo@acme.com' }, loggedOut: false }
          },
        }),
    })
    await expect(viaAttr.consume('globex', { SAMLResponse: 'x' })).rejects.toBeInstanceOf(SamlResponseInvalidError)
    // The legitimate IdP still logs the same user in.
    const ok = await saml.consume('acme', { SAMLResponse: 'x' })
    expect(ok.user.id).toBe(victim.id)
  })

  it('compares the domain case-insensitively and rejects look-alike / multi-@ emails', async () => {
    const saml = (email: string) => new Saml(makeAuth(), [acme, globex], { createClient: () => asserting(email) })
    await expect(saml('CEO@ACME.COM').consume('acme', { SAMLResponse: 'x' })).resolves.toBeTruthy()
    for (const email of [
      'ceo@acme.com@globex.com',
      'ceo@globex.com@acme.com',
      'ceo@evil-acme.com',
      'ceo@acme.com.evil.io',
      'ceo@sub.acme.com',
      'ceo@acme.com ',
      'ceo@acme.com\u200b',
      'ceo\u0000@acme.com',
      'no-at-sign',
    ]) {
      await expect(saml(email).consume('acme', { SAMLResponse: 'x' }), email).rejects.toBeInstanceOf(
        SamlResponseInvalidError,
      )
    }
  })

  it('refuses to boot with several providers unless each has an allowlist or an explicit opt-out', () => {
    const open = { ...provider, name: 'open' }
    expect(() => new Saml(makeAuth(), [acme, open], { createClient: () => fakeClient() })).toThrow(
      SamlProviderConfigError,
    )
    expect(
      () => new Saml(makeAuth(), [acme, { ...open, allowAnyEmailDomain: true }], { createClient: () => fakeClient() }),
    ).not.toThrow()
    // A single IdP (the app's own) needs no allowlist.
    expect(() => new Saml(makeAuth(), [open], { createClient: () => fakeClient() })).not.toThrow()
  })

  it('rejects malformed allowlist entries at boot', () => {
    for (const bad of [[], [''], ['@acme.com'], ['*.acme.com'], ['acme .com']]) {
      expect(
        () => new Saml(makeAuth(), [{ ...acme, allowedEmailDomains: bad }], { createClient: () => fakeClient() }),
        JSON.stringify(bad),
      ).toThrow(SamlProviderConfigError)
    }
  })
})

describe('F63 · @node-saml/node-saml peer floor excludes the signature-bypass releases', () => {
  it('requires >= 5.1.0 (CVE-2025-54369 / CVE-2025-54419 affect <= 5.0.1)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      peerDependencies: Record<string, string>
    }
    expect(pkg.peerDependencies['@node-saml/node-saml']).toBe('^5.1.0')
  })

  it('refuses a vulnerable node-saml version at boot', () => {
    expect(() => assertSafeNodeSamlVersion('5.0.1')).toThrow(SamlProviderConfigError)
    expect(() => assertSafeNodeSamlVersion('5.0.0')).toThrow(SamlProviderConfigError)
    expect(() => assertSafeNodeSamlVersion('4.9.9')).toThrow(SamlProviderConfigError)
    expect(() => assertSafeNodeSamlVersion('5.1.0')).not.toThrow()
    expect(() => assertSafeNodeSamlVersion('6.0.0')).not.toThrow()
  })
})

describe('F15b · duplicate provider names', () => {
  it('refuses two providers with the same name (one IdP would inherit the other allowlist)', () => {
    expect(
      () =>
        new Saml(
          makeAuth(),
          [
            { ...provider, allowedEmailDomains: ['acme.com'] },
            { ...provider, allowAnyEmailDomain: true },
          ],
          { createClient: () => fakeClient() },
        ),
    ).toThrow(SamlProviderConfigError)
  })
})

describe('F66 · SAML unsolicited assertions and replay', () => {
  it('requires InResponseTo by default (unsolicited / IdP-initiated responses are refused)', () => {
    expect(samlClientConfig(provider)['validateInResponseTo']).toBe('always')
  })

  it('IdP-initiated flows are an explicit opt-in', () => {
    expect(samlClientConfig(provider, { validateInResponseTo: 'ifPresent' })['validateInResponseTo']).toBe('ifPresent')
  })

  const assertionWithId = (id: string) =>
    fakeClient({
      async validatePostResponseAsync() {
        return {
          profile: {
            nameID: 'saml@corp.com',
            email: 'saml@corp.com',
            getAssertion: () => ({
              Assertion: {
                $: { ID: id },
                Conditions: [{ $: { NotOnOrAfter: new Date(Date.now() + 5 * 60_000).toISOString() } }],
              },
            }),
          },
          loggedOut: false,
        }
      },
    })

  it('a validated assertion is single-use (re-POSTing the same SAMLResponse fails)', async () => {
    const saml = new Saml(makeAuth(), [provider], {
      validateInResponseTo: 'ifPresent',
      createClient: () => assertionWithId('_a1'),
    })
    await expect(saml.consume('okta', { SAMLResponse: 'x' })).resolves.toBeTruthy()
    await expect(saml.consume('okta', { SAMLResponse: 'x' })).rejects.toBeInstanceOf(SamlResponseInvalidError)
  })

  it('without InResponseTo binding, an assertion with no identifier is refused', async () => {
    const saml = new Saml(makeAuth(), [provider], { validateInResponseTo: 'never', createClient: () => fakeClient() })
    await expect(saml.consume('okta', { SAMLResponse: 'x' })).rejects.toBeInstanceOf(SamlResponseInvalidError)
  })

  it('uses a pluggable replay cache (shared across replicas)', async () => {
    const seen = new Set<string>()
    const assertionReplayCache = {
      async consume(key: string) {
        if (seen.has(key)) return false
        seen.add(key)
        return true
      },
    }
    const a = new Saml(makeAuth(), [provider], { assertionReplayCache, createClient: () => assertionWithId('_r1') })
    const b = new Saml(makeAuth(), [provider], { assertionReplayCache, createClient: () => assertionWithId('_r1') })
    await expect(a.consume('okta', { SAMLResponse: 'x' })).resolves.toBeTruthy()
    await expect(b.consume('okta', { SAMLResponse: 'x' })).rejects.toBeInstanceOf(SamlResponseInvalidError)
  })
})
