import { createHash, generateKeyPairSync } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { Auth, MemoryUserSource, authPlugin } from '@basaltkit/auth'
import { signSamlPost } from '@node-saml/node-saml/lib/saml-post-signing.js'
import {
  Saml,
  SamlProviderConfigError,
  SamlResponseInvalidError,
  extractEmail,
  samlClientConfig,
  samlPlugin,
  samlRelayStateFor,
  samlRoutes,
  type SamlClient,
  type SamlProvider,
} from '../src/index.js'

/** Framework audit, pass 2: FA-057 (login CSRF, node-saml errors → 400) and FA-060. */

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
  // The fixture signs the assertion and the envelope.
}

function signedResponse(email: string, inResponseTo: string, id: string): string {
  const now = new Date()
  const later = new Date(now.getTime() + 5 * 60_000).toISOString()
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}">` +
    `<saml:Issuer>https://idp.acme.example</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${email}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later}" Recipient="${acme.callbackUrl}" InResponseTo="${inResponseTo}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later}">` +
    `<saml:AudienceRestriction><saml:Audience>${SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="s1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `</saml:Assertion>`
  const sign = (xml: string, node: string) =>
    signSamlPost(xml, `/*[local-name(.)="${node}"]`, { privateKey: KEY, signatureAlgorithm: 'sha256', digestAlgorithm: 'sha256' })
  const response =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="r${id}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${acme.callbackUrl}" InResponseTo="${inResponseTo}">` +
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">https://idp.acme.example</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    sign(assertion, 'Assertion').replace(/^<\?xml[^>]*>/, '') +
    `</samlp:Response>`
  return Buffer.from(sign(response, 'Response')).toString('base64')
}

async function start(saml: Saml): Promise<{ irt: string; binding: string; relayState: string }> {
  const { url: raw, binding } = await saml.authorize('acme')
  const url = new URL(raw)
  const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString()
  return { irt: /ID="([^"]+)"/.exec(xml)![1]!, binding, relayState: url.searchParams.get('RelayState')! }
}

/** Well-formed, signature-less responses for the stubbed-client route tests (the algorithm check runs first). */
const STUB = Buffer.from('<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="stub"/>').toString('base64')
const BOOM = Buffer.from('<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="boom"/>').toString('base64')

const newAuth = () => new Auth({ users: new MemoryUserSource(), secret: 'x'.repeat(32) })

describe('FA-057 · SAML login CSRF: a response is bound to the browser that started the login', () => {
  it("the attacker's own valid SAMLResponse cannot be posted from the victim's browser", async () => {
    const saml = new Saml(newAuth(), [acme])
    // The attacker starts a login in THEIR browser and captures their response.
    const attacker = await start(saml)
    const res = signedResponse('mallory@acme.com', attacker.irt, '_csrf1')
    // The victim's browser has no binding cookie, or one for its own login.
    await expect(saml.consume('acme', { SAMLResponse: res, RelayState: attacker.relayState })).rejects.toThrow(
      /not bound to the browser/,
    )
    const victim = await start(saml)
    await expect(
      saml.consume('acme', { SAMLResponse: res, RelayState: attacker.relayState }, { binding: victim.binding }),
    ).rejects.toBeInstanceOf(SamlResponseInvalidError)
    // Rewriting the RelayState to the victim's does not help: it must hash to the cookie.
    await expect(
      saml.consume('acme', { SAMLResponse: res, RelayState: victim.relayState }, { binding: attacker.binding }),
    ).rejects.toBeInstanceOf(SamlResponseInvalidError)
    // The attacker's own browser (right cookie) still logs in.
    const ok = await saml.consume('acme', { SAMLResponse: res, RelayState: attacker.relayState }, { binding: attacker.binding })
    expect(ok.user.email).toBe('mallory@acme.com')
  })

  it('the RelayState is the SHA-256 of the binding (the cookie value never reaches the IdP)', async () => {
    const saml = new Saml(newAuth(), [acme])
    const { binding, relayState } = await start(saml)
    expect(relayState).toBe(createHash('sha256').update(binding).digest('base64url'))
    expect(relayState).toBe(samlRelayStateFor(binding))
    expect(relayState).not.toContain(binding)
  })

  it('is an explicit opt-out, and not enforced for the IdP-initiated opt-in', () => {
    expect(new Saml(newAuth(), [acme]).bindsToBrowser).toBe(true)
    expect(new Saml(newAuth(), [acme], { bindToBrowser: false }).bindsToBrowser).toBe(false)
    expect(new Saml(newAuth(), [acme], { validateInResponseTo: 'ifPresent' }).bindsToBrowser).toBe(false)
  })
})

describe('FA-057 · node-saml failures are a 400, not a 500', () => {
  it('garbage, an unknown InResponseTo and a bad signature all map to AUTH_SAML_RESPONSE_INVALID', async () => {
    const saml = new Saml(newAuth(), [acme], { bindToBrowser: false })
    await expect(saml.consume('acme', { SAMLResponse: 'not-base64-xml' })).rejects.toBeInstanceOf(SamlResponseInvalidError)
    await expect(
      saml.consume('acme', { SAMLResponse: signedResponse('a@acme.com', '_never-issued', '_u9') }),
    ).rejects.toBeInstanceOf(SamlResponseInvalidError)
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const wrongCert = new Saml(newAuth(), [{ ...acme, idpCert: other }], { bindToBrowser: false })
    const { irt } = await (async () => {
      const url = new URL(await wrongCert.loginUrl('acme'))
      const xml = inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString()
      return { irt: /ID="([^"]+)"/.exec(xml)![1]! }
    })()
    await expect(wrongCert.consume('acme', { SAMLResponse: signedResponse('a@acme.com', irt, '_s9') })).rejects.toBeInstanceOf(
      SamlResponseInvalidError,
    )
  })
})

describe('FA-060 · SAML configuration and claim hardening', () => {
  it('a configured emailAttribute is the only source (no silent fallback to the NameID)', () => {
    expect(extractEmail({ nameID: 'boss@acme.com' }, 'mail')).toBeUndefined()
    expect(extractEmail({ nameID: 'x', email: 'boss@acme.com' }, 'mail')).toBeUndefined()
    expect(extractEmail({ mail: 'not-an-email' }, 'mail')).toBeUndefined()
    expect(extractEmail({ mail: 'ana@acme.com' }, 'mail')).toBe('ana@acme.com')
  })

  it('wantAuthnResponseSigned stays on by default and is a per-provider opt-out', () => {
    expect(samlClientConfig(acme)['wantAuthnResponseSigned']).toBe(true)
    expect(samlClientConfig({ ...acme, wantAuthnResponseSigned: false })['wantAuthnResponseSigned']).toBe(false)
    expect(samlClientConfig({ ...acme, wantAuthnResponseSigned: false })['wantAssertionsSigned']).toBe(true)
  })

  it('accepts a bounded clock skew', () => {
    expect('acceptedClockSkewMs' in samlClientConfig(acme)).toBe(false)
    expect(samlClientConfig({ ...acme, acceptedClockSkewMs: 60_000 })['acceptedClockSkewMs']).toBe(60_000)
    expect(() => samlClientConfig({ ...acme, acceptedClockSkewMs: 3_600_000 })).toThrow(SamlProviderConfigError)
    expect(() => samlClientConfig({ ...acme, acceptedClockSkewMs: -1 })).toThrow(SamlProviderConfigError)
  })
})

// --- routes over a real adapter (Fastify workspace build) ------------------------

type FastifyModule = { fastifyPlugin: (o: { routes: unknown[] }) => unknown; FASTIFY: unknown }
const fastifyModule = await import(new URL('../../fastify/dist/index.js', import.meta.url).href).catch(() => null) as FastifyModule | null

describe.skipIf(!fastifyModule)('FA-057 · samlRoutes set and require the binding cookie', () => {
  let shutdown: (() => Promise<void>) | undefined
  afterEach(async () => {
    await shutdown?.()
    shutdown = undefined
  })

  const client: SamlClient = {
    async getAuthorizeUrlAsync(relayState) {
      return `https://idp.acme.example/sso?SAMLRequest=req&RelayState=${encodeURIComponent(relayState)}`
    },
    async validatePostResponseAsync(container) {
      if (container['SAMLResponse'] === BOOM) throw new Error('Invalid signature')
      return { profile: { nameID: 'ana@acme.com', email: 'ana@acme.com' }, loggedOut: false }
    },
    generateServiceProviderMetadata: () => '<x/>',
  }

  async function bootApp() {
    const { fastifyPlugin, FASTIFY } = fastifyModule!
    const app = await createApp({
      plugins: [
        authPlugin({ users: new MemoryUserSource(), secret: 'x'.repeat(32) }),
        samlPlugin({ providers: [acme], createClient: () => client }),
        fastifyPlugin({ routes: samlRoutes({ bindingCookie: { secure: true } }) }),
      ] as never,
    }).boot()
    shutdown = () => app.shutdown()
    return app.container.get(FASTIFY as never) as unknown as {
      inject(o: Record<string, unknown>): Promise<{ statusCode: number; headers: Record<string, string>; json(): { error: { code: string } } }>
    }
  }

  it('login sets a SameSite=None; Secure __Host- cookie whose hash is the RelayState; the ACS needs it', async () => {
    const f = await bootApp()
    const login = await f.inject({ method: 'GET', url: '/auth/saml/acme/login' })
    expect(login.statusCode).toBe(302)
    const setCookie = String(login.headers['set-cookie'])
    expect(setCookie).toMatch(/^__Host-basalt_saml=[^;]+; Path=\/; HttpOnly; Max-Age=900; SameSite=None; Secure$/)
    const binding = decodeURIComponent(/^__Host-basalt_saml=([^;]+)/.exec(setCookie)![1]!)
    const relayState = new URL(login.headers['location']!).searchParams.get('RelayState')!
    expect(relayState).toBe(samlRelayStateFor(binding))

    const forged = await f.inject({ method: 'POST', url: '/auth/saml/acme/acs', payload: { SAMLResponse: STUB, RelayState: relayState } })
    expect(forged.statusCode).toBe(400)
    expect(forged.json().error.code).toBe('AUTH_SAML_RESPONSE_INVALID')

    const ok = await f.inject({
      method: 'POST',
      url: '/auth/saml/acme/acs',
      headers: { cookie: `__Host-basalt_saml=${encodeURIComponent(binding)}` },
      payload: { SAMLResponse: STUB, RelayState: relayState },
    })
    expect(ok.statusCode).toBe(200)
    expect(String(ok.headers['set-cookie'])).toContain('Max-Age=0')
  })

  it('a node-saml exception is a 400, and an oversized RelayState is refused', async () => {
    const f = await bootApp()
    const login = await f.inject({ method: 'GET', url: '/auth/saml/acme/login' })
    const binding = decodeURIComponent(/^__Host-basalt_saml=([^;]+)/.exec(String(login.headers['set-cookie']))![1]!)
    const boom = await f.inject({
      method: 'POST',
      url: '/auth/saml/acme/acs',
      headers: { cookie: `__Host-basalt_saml=${encodeURIComponent(binding)}` },
      payload: { SAMLResponse: BOOM, RelayState: samlRelayStateFor(binding) },
    })
    expect(boom.statusCode).toBe(400)
    expect(boom.json().error.code).toBe('AUTH_SAML_RESPONSE_INVALID')
    const long = await f.inject({ method: 'POST', url: '/auth/saml/acme/acs', payload: { SAMLResponse: STUB, RelayState: 'r'.repeat(2000) } })
    expect(long.statusCode).toBe(400)
  })

  it('the login and ACS routes are rate-limited by default', () => {
    const [login, acs, metadata] = samlRoutes()
    expect((login!.meta as { rateLimit?: unknown }).rateLimit).toEqual({ limit: 10, windowMs: 60_000 })
    expect((acs!.meta as { rateLimit?: unknown }).rateLimit).toEqual({ limit: 10, windowMs: 60_000 })
    expect((metadata!.meta as { rateLimit?: unknown } | undefined)?.rateLimit).toBeUndefined()
    expect((samlRoutes({ rateLimit: false })[0]!.meta as { rateLimit?: unknown }).rateLimit).toBeUndefined()
  })
})
