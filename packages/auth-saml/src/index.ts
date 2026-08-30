import { BasaltError, createToken, ctx, definePlugin, type Container } from '@basaltkit/core'
import { AUTH, type Auth, type PublicUser, type TokenPair } from '@basaltkit/auth'
import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'
import { SAML } from '@node-saml/node-saml'

export class SamlProviderUnknownError extends BasaltError {
  readonly status = 404
  constructor(name: string) {
    super('AUTH_SAML_UNKNOWN_PROVIDER', `Unknown SAML provider "${name}".`)
  }
}

export class SamlResponseInvalidError extends BasaltError {
  readonly status = 400
  constructor(detail = 'the assertion could not be validated') {
    super('AUTH_SAML_RESPONSE_INVALID', `SAML login failed: ${detail}.`)
  }
}

/** The subset of a node-saml profile we read. */
export interface SamlProfile {
  nameID?: string
  email?: string
  [claim: string]: unknown
}

/**
 * The node-saml surface this package uses — kept minimal so the underlying
 * library (which does the XML-DSig verification) is injectable in tests.
 */
export interface SamlClient {
  getAuthorizeUrlAsync(relayState: string, host: string | undefined, options: Record<string, unknown>): Promise<string>
  validatePostResponseAsync(container: Record<string, string>): Promise<{ profile: SamlProfile | null; loggedOut: boolean }>
  generateServiceProviderMetadata(decryptionCert: string | null, signingCert?: string | null): string
}

export interface SamlProvider {
  name: string
  /** IdP Single-Sign-On URL (HTTP-Redirect binding). */
  entryPoint: string
  /** IdP signing certificate(s) (PEM). Used to verify the assertion signature. */
  idpCert: string | string[]
  /** SP entity id (this app's issuer). */
  issuer: string
  /** ACS URL the IdP POSTs the SAMLResponse to. */
  callbackUrl: string
  /** Attribute to read the email from. Default: `email` / common email claims / an email-shaped NameID. */
  emailAttribute?: string
}

export interface SamlOptions {
  /**
   * Factory for the underlying SAML client. Default: `@node-saml/node-saml`.
   * Injectable for tests so the crypto path is exercised by the real library
   * in production but stubbed in unit tests.
   */
  createClient?: (provider: SamlProvider) => SamlClient
  /** Host used when building the AuthnRequest (optional). */
  host?: string
  /**
   * Assertion-replay protection. Default `'ifPresent'`: a response carrying an
   * `InResponseTo` must match an AuthnRequest this SP issued and not yet consumed.
   *
   * The request ids live in `cacheProvider` — node-saml's **in-process** cache by
   * default. Across several replicas without sticky sessions, a login started on
   * one replica and returning to another will fail with `AUTH_SAML_RESPONSE_INVALID`;
   * pass a shared `cacheProvider` (Redis, your database…), or set `'never'` to opt
   * out and accept the replay window.
   */
  validateInResponseTo?: ValidateInResponseToMode
  /** Shared store for outstanding AuthnRequest ids — required on multi-replica deployments. */
  cacheProvider?: SamlCacheProvider
}

/**
 * Replay protection: bind each SAMLResponse to an AuthnRequest this SP issued.
 * `ifPresent` (the default here — node-saml's own default is `never`) rejects a
 * response whose `InResponseTo` is unknown or already consumed, closing the
 * window in which a captured assertion can be replayed until its `NotOnOrAfter`.
 */
export type ValidateInResponseToMode = 'never' | 'ifPresent' | 'always'

/** node-saml's request-id cache contract, re-exported so apps can supply a shared one. */
export interface SamlCacheProvider {
  saveAsync(key: string, value: string): Promise<unknown>
  getAsync(key: string): Promise<string | null>
  removeAsync(key: string | null): Promise<string | null>
}

/**
 * The node-saml configuration this package builds for a provider. Exported so the
 * security-relevant defaults are assertable without constructing a real client.
 */
export function samlClientConfig(p: SamlProvider, options: SamlOptions = {}): Record<string, unknown> {
  return {
    callbackUrl: p.callbackUrl,
    entryPoint: p.entryPoint,
    issuer: p.issuer,
    idpCert: p.idpCert,
    // Require the IdP to sign assertions — never trust an unsigned response.
    wantAssertionsSigned: true,
    // Reject replays of a captured assertion (see ValidateInResponseToMode).
    validateInResponseTo: options.validateInResponseTo ?? 'ifPresent',
    ...(options.cacheProvider ? { cacheProvider: options.cacheProvider } : {}),
  }
}

function defaultCreateClient(p: SamlProvider, options: SamlOptions): SamlClient {
  return new SAML(
    samlClientConfig(p, options) as unknown as ConstructorParameters<typeof SAML>[0],
  ) as unknown as SamlClient
}

const EMAIL_CLAIMS = [
  'email',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
]

/** Extracts the user's email from a validated assertion. */
export function extractEmail(profile: SamlProfile, attribute?: string): string | undefined {
  if (attribute) {
    const v = profile[attribute]
    if (typeof v === 'string' && v) return v
  }
  for (const key of EMAIL_CLAIMS) {
    const v = profile[key]
    if (typeof v === 'string' && v.includes('@')) return v
  }
  if (typeof profile.nameID === 'string' && profile.nameID.includes('@')) return profile.nameID
  return undefined
}

/**
 * SAML 2.0 SP-initiated SSO. Signature verification, canonicalization and the
 * SAML protocol are delegated to `@node-saml/node-saml`; this only wires the
 * result into {@link Auth.socialLogin}. A validated assertion is trusted, so the
 * user is logged in with `emailVerified: true`.
 */
export class Saml {
  private readonly providers = new Map<string, SamlProvider>()
  private readonly clients = new Map<string, SamlClient>()

  constructor(
    private readonly auth: Auth,
    providers: SamlProvider[],
    private readonly options: SamlOptions = {},
  ) {
    const create = options.createClient ?? ((p: SamlProvider) => defaultCreateClient(p, options))
    for (const p of providers) {
      this.providers.set(p.name, p)
      this.clients.set(p.name, create(p))
    }
  }

  names(): string[] {
    return [...this.clients.keys()]
  }

  private lookup(name: string): { provider: SamlProvider; client: SamlClient } {
    const provider = this.providers.get(name)
    const client = this.clients.get(name)
    if (!provider || !client) throw new SamlProviderUnknownError(name)
    return { provider, client }
  }

  /** The IdP redirect URL to start login (SP-initiated). */
  loginUrl(name: string, relayState = ''): Promise<string> {
    return this.lookup(name).client.getAuthorizeUrlAsync(relayState, this.options.host, {})
  }

  /** Validates a posted SAMLResponse and logs the user in by email. */
  async consume(
    name: string,
    body: { SAMLResponse: string; RelayState?: string },
  ): Promise<{ user: PublicUser; tokens: TokenPair; created: boolean }> {
    const { provider, client } = this.lookup(name)
    const { profile } = await client.validatePostResponseAsync({
      SAMLResponse: body.SAMLResponse,
      ...(body.RelayState ? { RelayState: body.RelayState } : {}),
    })
    if (!profile) throw new SamlResponseInvalidError()
    const email = extractEmail(profile, provider.emailAttribute)
    if (!email) throw new SamlResponseInvalidError('no email in the assertion')
    return this.auth.socialLogin(email, { emailVerified: true })
  }

  /** SP metadata XML (hand this to the IdP admin to register the SP). */
  metadata(name: string): string {
    return this.lookup(name).client.generateServiceProviderMetadata(null, null)
  }
}

export const SAML_SSO = createToken<Saml>('auth.saml')

export interface SamlPluginOptions extends SamlOptions {
  providers: SamlProvider[]
}

/**
 * Registers the {@link Saml} service (token {@link SAML_SSO}). Adapter-agnostic —
 * the Fastify, Express and Hono adapters all parse the
 * `application/x-www-form-urlencoded` ACS POST. Register it after `authPlugin`.
 */
export function samlPlugin(options: SamlPluginOptions) {
  const { providers, ...rest } = options
  return definePlugin({
    name: 'basalt:auth:saml',
    register({ container }) {
      container.singleton(SAML_SSO, (c) => new Saml(c.get(AUTH), providers, rest))
    },
  })
}

export interface SamlRoutesOptions {
  /**
   * When set, the ACS redirects the browser here after login with
   * `#access_token=…&refresh_token=…`. Omitted → JSON `{ user, accessToken, refreshToken }`.
   */
  successRedirect?: string
}

/**
 * Ready-made SAML routes:
 *  - `GET  /auth/saml/:provider/login`    → 302 to the IdP.
 *  - `POST /auth/saml/:provider/acs`      → validate the assertion and log in.
 *  - `GET  /auth/saml/:provider/metadata` → SP metadata XML.
 */
export function samlRoutes(options: SamlRoutesOptions = {}): BasaltRoute[] {
  const saml = () => (ctx().container as Container).get(SAML_SSO)
  return [
    route({
      method: 'GET',
      url: '/auth/saml/:provider/login',
      params: z.object({ provider: z.string() }),
      query: z.object({ RelayState: z.string().optional() }),
      async handler({ params, query, reply }) {
        const url = await saml().loginUrl(params.provider, query.RelayState ?? '')
        return reply.code(302).header('location', url).send()
      },
    }),
    route({
      method: 'POST',
      url: '/auth/saml/:provider/acs',
      params: z.object({ provider: z.string() }),
      body: z.object({ SAMLResponse: z.string(), RelayState: z.string().optional() }),
      async handler({ params, body, reply }) {
        const { user, tokens } = await saml().consume(params.provider, {
          SAMLResponse: body.SAMLResponse,
          ...(body.RelayState ? { RelayState: body.RelayState } : {}),
        })
        if (options.successRedirect) {
          const url = new URL(options.successRedirect)
          url.hash = new URLSearchParams({
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
          }).toString()
          return reply.code(302).header('location', url.toString()).send()
        }
        return { user, ...tokens }
      },
    }),
    route({
      method: 'GET',
      url: '/auth/saml/:provider/metadata',
      params: z.object({ provider: z.string() }),
      async handler({ params, reply }) {
        return reply.code(200).header('content-type', 'application/xml').send(saml().metadata(params.provider))
      },
    }),
  ]
}
