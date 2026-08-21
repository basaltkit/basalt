import { describe, expect, it } from 'vitest'
import { Auth, MemoryUserSource } from '@basaltkit/auth'
import {
  extractEmail,
  Saml,
  SamlProviderUnknownError,
  SamlResponseInvalidError,
  type SamlClient,
  type SamlProvider,
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
