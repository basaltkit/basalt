import { generateKeyPairSync } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Auth, MemoryUserSource } from '@basaltkit/auth'
// Test-only helper from node-saml to sign fixtures with a throwaway test key.
import { signSamlPost } from '@node-saml/node-saml/lib/saml-post-signing.js'
import { Saml, SamlResponseInvalidError, type SamlProvider } from '../src/index.js'

// Real XML-DSig path: assertions signed with a throwaway key generated per run and
// verified by the actual @node-saml/node-saml client (no stubbed client).
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const CERT = publicKey.export({ type: 'spki', format: 'pem' }).toString()

const SP = 'https://sp.example'
const acs = (name: string) => `${SP}/auth/saml/${name}/acs`
const prov = (name: string, domains: string[]): SamlProvider => ({
  name,
  entryPoint: `https://idp.${name}.example/sso`,
  idpCert: CERT,
  issuer: SP,
  callbackUrl: acs(name),
  allowedEmailDomains: domains,
})

function signedResponse(opts: {
  provider: string
  email: string
  inResponseTo?: string
  id: string
  /** Lifetime of the assertion (Conditions / SubjectConfirmationData NotOnOrAfter). Default 5 min. */
  lifetimeMs?: number
  /** Emit `<Conditions>` with no NotBefore/NotOnOrAfter (node-saml then applies no time bound). */
  unboundedConditions?: boolean
}): string {
  const now = new Date()
  const later = new Date(now.getTime() + (opts.lifetimeMs ?? 5 * 60_000)).toISOString()
  const irt = opts.inResponseTo ? ` InResponseTo="${opts.inResponseTo}"` : ''
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${opts.id}" Version="2.0" IssueInstant="${now.toISOString()}">` +
    `<saml:Issuer>https://idp.${opts.provider}.example</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later}" Recipient="${acs(opts.provider)}"${irt}/></saml:SubjectConfirmation></saml:Subject>` +
    (opts.unboundedConditions
      ? `<saml:Conditions>`
      : `<saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later}">`) +
    `<saml:AudienceRestriction><saml:Audience>${SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `</saml:Assertion>`
  const signed = signSamlPost(assertion, '/*[local-name(.)="Assertion"]', {
    privateKey: KEY,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
  })
  const response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="r${opts.id}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${acs(opts.provider)}"${irt}>` +
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://idp.${opts.provider}.example</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    signed.replace(/^<\?xml[^>]*>/, '') +
    `</samlp:Response>`
  const signedResponse = signSamlPost(response, '/*[local-name(.)="Response"]', {
    privateKey: KEY,
    signatureAlgorithm: 'sha256',
    digestAlgorithm: 'sha256',
  })
  return Buffer.from(signedResponse).toString('base64')
}

async function requestId(saml: Saml, name: string): Promise<string> {
  const url = new URL(await saml.loginUrl(name))
  const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString()
  return /ID="([^"]+)"/.exec(xml)![1]!
}

describe('auth-saml over the real node-saml client', () => {
  const setup = async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: 'x'.repeat(32) })
    const victim = await auth.register('ceo@acme.com', 'password123')
    const saml = new Saml(auth, [prov('acme', ['acme.com']), prov('globex', ['globex.com'])])
    return { saml, victim }
  }

  it('logs in a solicited, correctly signed assertion from the right IdP', async () => {
    const { saml, victim } = await setup()
    const irt = await requestId(saml, 'acme')
    const r = await saml.consume('acme', { SAMLResponse: signedResponse({ provider: 'acme', email: 'ceo@acme.com', inResponseTo: irt, id: '_ok1' }) })
    expect(r.user.id).toBe(victim.id)
  })

  it("rejects a validly signed assertion from another customer's IdP for the victim's email", async () => {
    const { saml } = await setup()
    const irt = await requestId(saml, 'globex')
    const res = signedResponse({ provider: 'globex', email: 'ceo@acme.com', inResponseTo: irt, id: '_x1' })
    await expect(saml.consume('globex', { SAMLResponse: res })).rejects.toBeInstanceOf(SamlResponseInvalidError)
  })

  it('rejects an unsolicited (no InResponseTo) response by default', async () => {
    const { saml } = await setup()
    const res = signedResponse({ provider: 'acme', email: 'ceo@acme.com', id: '_u1' })
    await expect(saml.consume('acme', { SAMLResponse: res })).rejects.toThrow()
  })

  it('rejects a replay of a consumed response', async () => {
    const { saml } = await setup()
    const irt = await requestId(saml, 'acme')
    const res = signedResponse({ provider: 'acme', email: 'ceo@acme.com', inResponseTo: irt, id: '_rp1' })
    await expect(saml.consume('acme', { SAMLResponse: res })).resolves.toBeTruthy()
    await expect(saml.consume('acme', { SAMLResponse: res })).rejects.toThrow()
  })

  it('with the IdP-initiated opt-in, an unsolicited assertion is still single-use', async () => {
    const auth = new Auth({ users: new MemoryUserSource(), secret: 'x'.repeat(32) })
    const saml = new Saml(auth, [prov('acme', ['acme.com'])], { validateInResponseTo: 'ifPresent' })
    const res = signedResponse({ provider: 'acme', email: 'ceo@acme.com', id: '_idp1' })
    await expect(saml.consume('acme', { SAMLResponse: res })).resolves.toBeTruthy()
    await expect(saml.consume('acme', { SAMLResponse: res })).rejects.toBeInstanceOf(SamlResponseInvalidError)
  })

  describe('single use outlives the assertion (IdP-initiated opt-in)', () => {
    afterEach(() => {
      vi.useRealTimers()
    })
    const idpInitiated = () => {
      const auth = new Auth({ users: new MemoryUserSource(), secret: 'x'.repeat(32) })
      return new Saml(auth, [prov('acme', ['acme.com'])], { validateInResponseTo: 'ifPresent' })
    }

    it('refuses an assertion with no NotOnOrAfter (it could be replayed once the replay record expires)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const saml = idpInitiated()
      const res = signedResponse({ provider: 'acme', email: 'ceo@acme.com', id: '_nb1', unboundedConditions: true })
      await expect(saml.consume('acme', { SAMLResponse: res })).rejects.toBeInstanceOf(SamlResponseInvalidError)
      vi.setSystemTime(Date.now() + 2 * 60 * 60_000)
      await expect(saml.consume('acme', { SAMLResponse: res })).rejects.toBeInstanceOf(SamlResponseInvalidError)
    })

    it('refuses an assertion valid for longer than the replay record can be kept', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const saml = idpInitiated()
      const res = signedResponse({ provider: 'acme', email: 'ceo@acme.com', id: '_ll1', lifetimeMs: 48 * 60 * 60_000 })
      // Accepting it now would only record it for 24h, leaving it replayable for the next 24h.
      await expect(saml.consume('acme', { SAMLResponse: res })).rejects.toBeInstanceOf(SamlResponseInvalidError)
      // Once its remaining validity fits the record, it is accepted exactly once.
      vi.setSystemTime(Date.now() + 25 * 60 * 60_000)
      await expect(saml.consume('acme', { SAMLResponse: res })).resolves.toBeTruthy()
      vi.setSystemTime(Date.now() + 22 * 60 * 60_000)
      await expect(saml.consume('acme', { SAMLResponse: res })).rejects.toBeInstanceOf(SamlResponseInvalidError)
    })

    it('an assertion is refused for as long as node-saml would accept it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const saml = idpInitiated()
      const res = signedResponse({ provider: 'acme', email: 'ceo@acme.com', id: '_ok9', lifetimeMs: 2 * 60 * 60_000 })
      await expect(saml.consume('acme', { SAMLResponse: res })).resolves.toBeTruthy()
      vi.setSystemTime(Date.now() + 90 * 60_000)
      await expect(saml.consume('acme', { SAMLResponse: res })).rejects.toBeInstanceOf(SamlResponseInvalidError)
    })
  })
})
