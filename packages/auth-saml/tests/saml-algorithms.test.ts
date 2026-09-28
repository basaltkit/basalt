import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Auth, MemoryUserSource } from '@basaltkit/auth'
// Test-only helper from node-saml to sign fixtures with a throwaway test key.
import { signSamlPost } from '@node-saml/node-saml/lib/saml-post-signing.js'
import {
  DEFAULT_SAML_DIGEST_ALGORITHMS,
  DEFAULT_SAML_SIGNATURE_ALGORITHMS,
  Saml,
  SamlProviderConfigError,
  SamlResponseInvalidError,
  assertSamlResponseAlgorithms,
  samlAlgorithmPolicy,
  samlClientConfig,
  type SamlProvider,
} from '../src/index.js'

/** Framework audit FA-060: XML-DSig algorithm allowlist (SHA-1 refused by default). */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const CERT = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const SP = 'https://sp.example'
const acme: SamlProvider = {
  name: 'acme',
  entryPoint: 'https://idp.acme.example/sso',
  idpCert: CERT,
  issuer: SP,
  callbackUrl: `${SP}/auth/saml/acme/acs`,
  allowedEmailDomains: ['acme.com'],
}

type Alg = 'sha1' | 'sha256' | 'sha512'

/** A real node-saml-signed, unsolicited response; the assertion and the envelope each get their own algorithm. */
function signedXml(id: string, algs: { assertion: Alg; response: Alg }): string {
  const now = new Date()
  const later = new Date(now.getTime() + 5 * 60_000).toISOString()
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}">` +
    `<saml:Issuer>https://idp.acme.example</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">ana@acme.com</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later}" Recipient="${acme.callbackUrl}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later}">` +
    `<saml:AudienceRestriction><saml:Audience>${SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `</saml:Assertion>`
  const sign = (xml: string, node: string, alg: Alg) =>
    signSamlPost(xml, `/*[local-name(.)="${node}"]`, { privateKey: KEY, signatureAlgorithm: alg, digestAlgorithm: alg })
  const response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="r${id}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${acme.callbackUrl}">` +
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://idp.acme.example</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    sign(assertion, 'Assertion', algs.assertion).replace(/^<\?xml[^>]*>/, '') +
    `</samlp:Response>`
  return sign(response, 'Response', algs.response)
}
const b64 = (xml: string) => Buffer.from(xml).toString('base64')

// IdP-initiated opt-in so the fixtures need no AuthnRequest round-trip.
const samlFor = (provider: SamlProvider = acme) =>
  new Saml(new Auth({ users: new MemoryUserSource(), secret: 'x'.repeat(32) }), [provider], {
    validateInResponseTo: 'ifPresent',
  })

const NOT_ALLOWED = /algorithm is not allowed/

describe('FA-060 · XML-DSig algorithm allowlist over the real node-saml client', () => {
  it('accepts SHA-256 (and SHA-512) signatures and digests', async () => {
    const saml = samlFor()
    await expect(saml.consume('acme', { SAMLResponse: b64(signedXml('_a256', { assertion: 'sha256', response: 'sha256' })) })).resolves.toBeTruthy()
    await expect(saml.consume('acme', { SAMLResponse: b64(signedXml('_a512', { assertion: 'sha512', response: 'sha512' })) })).resolves.toBeTruthy()
  })

  it('refuses a validly signed SHA-1 response by default', async () => {
    const res = b64(signedXml('_s1', { assertion: 'sha1', response: 'sha1' }))
    const err = await samlFor().consume('acme', { SAMLResponse: res }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SamlResponseInvalidError)
    expect((err as Error).message).toMatch(NOT_ALLOWED)
  })

  it('refuses a SHA-1 assertion signature nested in a SHA-256 envelope', async () => {
    const res = b64(signedXml('_n1', { assertion: 'sha1', response: 'sha256' }))
    await expect(samlFor().consume('acme', { SAMLResponse: res })).rejects.toThrow(NOT_ALLOWED)
    // Also when the IdP signs only the assertion.
    await expect(samlFor({ ...acme, wantAuthnResponseSigned: false }).consume('acme', { SAMLResponse: res })).rejects.toThrow(NOT_ALLOWED)
  })

  it('accepts SHA-1 with the per-provider allowSha1 opt-in', async () => {
    const legacy = samlFor({ ...acme, allowSha1: true })
    await expect(legacy.consume('acme', { SAMLResponse: b64(signedXml('_l1', { assertion: 'sha1', response: 'sha1' })) })).resolves.toBeTruthy()
    await expect(legacy.consume('acme', { SAMLResponse: b64(signedXml('_l2', { assertion: 'sha256', response: 'sha256' })) })).resolves.toBeTruthy()
  })

  it('refuses a tampered Algorithm attribute in the nested assertion signature, whatever its spelling', async () => {
    const xml = signedXml('_t1', { assertion: 'sha256', response: 'sha256' })
    const assertionStart = xml.indexOf('<saml:Assertion')
    const head = xml.slice(0, assertionStart)
    const tail = xml.slice(assertionStart)
    const sha1Sig = 'http://www.w3.org/2000/09/xmldsig#rsa-sha1'
    const sha1Digest = 'http://www.w3.org/2000/09/xmldsig#sha1'
    const variants = [
      // Plain swap of the nested SignatureMethod / DigestMethod.
      tail.replace(/(<(?:\w+:)?SignatureMethod Algorithm=")[^"]+/, `$1${sha1Sig}`),
      tail.replace(/(<(?:\w+:)?DigestMethod Algorithm=")[^"]+/, `$1${sha1Digest}`),
      // A second, namespaced Algorithm attribute (xml-crypto matches attributes by local name).
      tail.replace(/(<(?:\w+:)?DigestMethod )/, `$1xmlns:z="urn:z" z:Algorithm="${sha1Digest}" `),
      // Character references in the attribute value.
      tail.replace(/(<(?:\w+:)?SignatureMethod Algorithm=")[^"]+/, `$1http://www.w3.org/2000/09/xmldsig#&#x72;sa-sha1`),
      // A SignatureMethod with no Algorithm at all.
      tail.replace(/(<(?:\w+:)?SignatureMethod) Algorithm="[^"]+"/, '$1'),
      // A prefixed dsig element.
      tail.replace(
        /<(?:\w+:)?SignatureMethod Algorithm="[^"]+"\s*\/>/,
        `<ds:SignatureMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="${sha1Sig}"/>`,
      ),
    ]
    for (const [i, t] of variants.entries()) {
      expect(t, `variant ${i} changed the fixture`).not.toBe(tail)
      await expect(samlFor().consume('acme', { SAMLResponse: b64(head + t) }), `variant ${i}`).rejects.toThrow(
        /algorithm is not allowed|has no Algorithm/,
      )
    }
  })

  it('a custom allowlist replaces the default', async () => {
    const strict = samlFor({ ...acme, signatureAlgorithms: ['http://www.w3.org/2001/04/xmldsig-more#rsa-sha512'] })
    await expect(strict.consume('acme', { SAMLResponse: b64(signedXml('_c1', { assertion: 'sha256', response: 'sha256' })) })).rejects.toThrow(NOT_ALLOWED)
    await expect(strict.consume('acme', { SAMLResponse: b64(signedXml('_c2', { assertion: 'sha512', response: 'sha512' })) })).resolves.toBeTruthy()
  })

  it('refuses a DOCTYPE / entity declaration and malformed XML', async () => {
    const xml = signedXml('_d1', { assertion: 'sha256', response: 'sha256' })
    const withDoctype = xml.replace(/^(<\?xml[^>]*>)?/, '$1<!DOCTYPE r [<!ENTITY e "x">]>')
    await expect(samlFor().consume('acme', { SAMLResponse: b64(withDoctype) })).rejects.toThrow(/DOCTYPE/)
    await expect(samlFor().consume('acme', { SAMLResponse: 'not-base64-xml' })).rejects.toBeInstanceOf(SamlResponseInvalidError)
  })
})

describe('FA-060 · algorithm policy configuration', () => {
  it('defaults exclude SHA-1; allowSha1 adds it', () => {
    const policy = samlAlgorithmPolicy(acme)
    expect([...policy.signatureAlgorithms]).toEqual([...DEFAULT_SAML_SIGNATURE_ALGORITHMS])
    expect([...policy.digestAlgorithms]).toEqual([...DEFAULT_SAML_DIGEST_ALGORITHMS])
    expect([...policy.signatureAlgorithms, ...policy.digestAlgorithms].some((a) => a.includes('sha1'))).toBe(false)
    const legacy = samlAlgorithmPolicy({ ...acme, allowSha1: true })
    expect(legacy.signatureAlgorithms.has('http://www.w3.org/2000/09/xmldsig#rsa-sha1')).toBe(true)
    expect(legacy.digestAlgorithms.has('http://www.w3.org/2000/09/xmldsig#sha1')).toBe(true)
  })

  it('an empty or invalid algorithm list is a boot-time config error', () => {
    expect(() => samlFor({ ...acme, signatureAlgorithms: [] })).toThrow(SamlProviderConfigError)
    expect(() => samlFor({ ...acme, digestAlgorithms: [42 as unknown as string] })).toThrow(SamlProviderConfigError)
  })

  it('a response without any signature passes the allowlist (node-saml then requires one)', () => {
    const bare = b64('<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>')
    expect(() => assertSamlResponseAlgorithms(bare, samlAlgorithmPolicy(acme))).not.toThrow()
  })

  it("node-saml's signing-side algorithms default to SHA-256", () => {
    expect(samlClientConfig(acme)['signatureAlgorithm']).toBe('sha256')
    expect(samlClientConfig(acme)['digestAlgorithm']).toBe('sha256')
  })
})
