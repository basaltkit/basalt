import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
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

/** Thrown at boot when the SAML configuration is unsafe (see {@link SamlProvider.allowedEmailDomains}). */
export class SamlProviderConfigError extends BasaltError {
  readonly status = 500
  constructor(detail: string) {
    super('AUTH_SAML_PROVIDER_CONFIG', `Unsafe SAML configuration: ${detail}.`)
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
  /**
   * Email domains this IdP is trusted to assert (exact, case-insensitive match on
   * the part after `@`; list subdomains explicitly). An assertion for any other
   * domain is rejected with `AUTH_SAML_RESPONSE_INVALID`.
   *
   * In B2B SaaS each customer's IdP admin controls what their IdP signs, so without
   * this list one customer's IdP could log in as another customer's users. It is
   * **required** when more than one provider is configured, unless the provider
   * explicitly sets {@link allowAnyEmailDomain}.
   */
  allowedEmailDomains?: string[]
  /**
   * Explicit opt-out of {@link allowedEmailDomains} when several providers are
   * configured: this IdP may assert **any** email. Only for an IdP you fully control.
   */
  allowAnyEmailDomain?: true
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
   * Assertion-replay protection. Default `'always'`: every response must carry an
   * `InResponseTo` matching an AuthnRequest this SP issued and not yet consumed, so
   * unsolicited (IdP-initiated) responses are refused. Set `'ifPresent'` to opt in
   * to IdP-initiated SSO (or `'never'`); consumed assertion ids are then also kept in
   * {@link assertionReplayCache} so a captured response cannot be re-posted.
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
  /**
   * Single-use store for consumed assertion ids. Default: an in-process map
   * (entries expire with the assertion). Pass a shared one (Redis `SET NX PX`, a
   * unique DB row…) on multi-replica deployments that opt in to IdP-initiated SSO.
   */
  assertionReplayCache?: SamlAssertionReplayCache
}

/** Single-use store for consumed assertion ids. */
export interface SamlAssertionReplayCache {
  /**
   * Atomically records `key` for `ttlMs`. Resolves `true` when the key was not
   * present (first use), `false` when it was already consumed.
   */
  consume(key: string, ttlMs: number): Promise<boolean>
}

/** In-process {@link SamlAssertionReplayCache} (per replica). */
export class MemoryAssertionReplayCache implements SamlAssertionReplayCache {
  private readonly seen = new Map<string, number>()
  constructor(private readonly now: () => number = Date.now) {}

  async consume(key: string, ttlMs: number): Promise<boolean> {
    const now = this.now()
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k)
    if (this.seen.has(key)) return false
    this.seen.set(key, now + ttlMs)
    return true
  }
}

/**
 * Replay protection: bind each SAMLResponse to an AuthnRequest this SP issued.
 * `always` (the default here — node-saml's own default is `never`) rejects a
 * response whose `InResponseTo` is missing, unknown or already consumed, closing
 * the window in which a captured assertion can be replayed until its
 * `NotOnOrAfter`. `ifPresent` additionally accepts unsolicited (IdP-initiated)
 * responses — an explicit opt-in.
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
    validateInResponseTo: options.validateInResponseTo ?? 'always',
    ...(options.cacheProvider ? { cacheProvider: options.cacheProvider } : {}),
  }
}

/** First @node-saml/node-saml release without CVE-2025-54369 / CVE-2025-54419 (signature bypass). */
const MIN_NODE_SAML = [5, 1, 0] as const

/**
 * Throws {@link SamlProviderConfigError} when `version` is below the first
 * @node-saml/node-saml release free of the known signature-bypass CVEs.
 */
export function assertSafeNodeSamlVersion(version: string): void {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  const v = parts ? [Number(parts[1]), Number(parts[2]), Number(parts[3])] : null
  const ok =
    v !== null &&
    (v[0]! !== MIN_NODE_SAML[0]
      ? v[0]! > MIN_NODE_SAML[0]
      : v[1]! !== MIN_NODE_SAML[1]
        ? v[1]! > MIN_NODE_SAML[1]
        : v[2]! >= MIN_NODE_SAML[2])
  if (!ok) {
    throw new SamlProviderConfigError(
      `@node-saml/node-saml ${version} has known signature-bypass vulnerabilities; upgrade to >= ${MIN_NODE_SAML.join('.')}`,
    )
  }
}

function installedNodeSamlVersion(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url)('@node-saml/node-saml/package.json') as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined // bundled / unresolvable — the peer range is the primary control
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

const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/

function normalizeAllowedDomains(p: SamlProvider): Set<string> | undefined {
  if (p.allowedEmailDomains === undefined) return undefined
  if (!Array.isArray(p.allowedEmailDomains) || p.allowedEmailDomains.length === 0) {
    throw new SamlProviderConfigError(`provider "${p.name}" has an empty allowedEmailDomains list`)
  }
  const out = new Set<string>()
  for (const d of p.allowedEmailDomains) {
    const n = typeof d === 'string' ? d.toLowerCase() : ''
    if (!DOMAIN_RE.test(n)) {
      throw new SamlProviderConfigError(`provider "${p.name}" has an invalid allowedEmailDomains entry ${JSON.stringify(d)}`)
    }
    out.add(n)
  }
  return out
}

/** The domain of a single-`@`, whitespace/control-free email, lowercased; otherwise `undefined`. */
function emailDomain(email: string): string | undefined {
  if (/[\s\p{Cc}\p{Cf}]/u.test(email)) return undefined
  const at = email.indexOf('@')
  if (at <= 0 || at !== email.lastIndexOf('@')) return undefined
  return email.slice(at + 1).toLowerCase()
}

/** The assertion's `ID` (or a digest of its XML), used as the single-use key. */
function assertionKey(profile: SamlProfile): string | undefined {
  const getAssertion = profile['getAssertion']
  if (typeof getAssertion === 'function') {
    const doc = (getAssertion as () => unknown).call(profile) as { Assertion?: { $?: { ID?: unknown } } } | undefined
    const id = doc?.Assertion?.$?.ID
    if (typeof id === 'string' && id) return `id:${id}`
  }
  const getXml = profile['getAssertionXml']
  if (typeof getXml === 'function') {
    const xml = (getXml as () => unknown).call(profile)
    if (typeof xml === 'string' && xml) return `sha256:${createHash('sha256').update(xml).digest('hex')}`
  }
  return undefined
}

const DEFAULT_REPLAY_TTL_MS = 60 * 60_000
const MAX_REPLAY_TTL_MS = 24 * 60 * 60_000
/** Margin kept past `NotOnOrAfter`, covering clock skew between the IdP and replicas. */
const REPLAY_SKEW_MS = 5 * 60_000

/**
 * The instant after which the assertion is no longer accepted, from
 * `Conditions/@NotOnOrAfter`, or `undefined` when it carries none (node-saml then
 * applies no time bound at all to an unsolicited response).
 */
function assertionExpiry(profile: SamlProfile): number | undefined {
  const getAssertion = profile['getAssertion']
  if (typeof getAssertion !== 'function') return undefined
  const doc = (getAssertion as () => unknown).call(profile) as
    | { Assertion?: { Conditions?: Array<{ $?: { NotOnOrAfter?: unknown } }> } }
    | undefined
  const noa = doc?.Assertion?.Conditions?.[0]?.$?.NotOnOrAfter
  const t = typeof noa === 'string' ? Date.parse(noa) : NaN
  return Number.isFinite(t) ? t : undefined
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
  private readonly allowedDomains = new Map<string, Set<string>>()
  private readonly replay: SamlAssertionReplayCache

  constructor(
    private readonly auth: Auth,
    providers: SamlProvider[],
    private readonly options: SamlOptions = {},
  ) {
    if (!options.createClient) {
      const version = installedNodeSamlVersion()
      if (version) assertSafeNodeSamlVersion(version)
    }
    const seen = new Set<string>()
    for (const p of providers) {
      // A duplicate name would silently pair one entry's IdP with another's allowlist.
      if (seen.has(p.name)) throw new SamlProviderConfigError(`provider "${p.name}" is configured more than once`)
      seen.add(p.name)
      const domains = normalizeAllowedDomains(p)
      if (domains) this.allowedDomains.set(p.name, domains)
      else if (providers.length > 1 && p.allowAnyEmailDomain !== true) {
        throw new SamlProviderConfigError(
          `provider "${p.name}" has no allowedEmailDomains; with several IdPs each one must be restricted to its ` +
            'own email domains (or set allowAnyEmailDomain: true for an IdP you fully control)',
        )
      }
    }
    this.replay = options.assertionReplayCache ?? new MemoryAssertionReplayCache()
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
    const allowed = this.allowedDomains.get(provider.name)
    if (allowed) {
      const domain = emailDomain(email)
      if (!domain || !allowed.has(domain)) {
        throw new SamlResponseInvalidError('the identity provider is not trusted for this email domain')
      }
    }
    // Single-use assertions. With `validateInResponseTo: 'always'` node-saml already
    // consumes the AuthnRequest id; this also covers the IdP-initiated opt-in.
    const bound = (this.options.validateInResponseTo ?? 'always') === 'always'
    const now = Date.now()
    const expiry = assertionExpiry(profile)
    let ttl = expiry === undefined ? DEFAULT_REPLAY_TTL_MS : Math.max(expiry - now, 0) + REPLAY_SKEW_MS
    if (!bound) {
      // Without request binding the replay record is the only single-use control, so it
      // must outlive the assertion: refuse assertions with no (or too distant) expiry.
      if (expiry === undefined) {
        throw new SamlResponseInvalidError('the assertion has no NotOnOrAfter to bound its single use')
      }
      if (ttl > MAX_REPLAY_TTL_MS) {
        throw new SamlResponseInvalidError('the assertion is valid for too long to enforce single use')
      }
    }
    ttl = Math.min(ttl, MAX_REPLAY_TTL_MS)
    const key = assertionKey(profile)
    if (key) {
      const first = await this.replay.consume(`${provider.name}:${key}`, ttl)
      if (!first) throw new SamlResponseInvalidError('the assertion was already used')
    } else if (!bound) {
      throw new SamlResponseInvalidError('the assertion has no identifier to enforce single use')
    }
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
