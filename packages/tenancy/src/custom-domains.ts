import { createHmac, randomBytes } from 'node:crypto'
import { resolveTxt as dnsResolveTxt } from 'node:dns/promises'
import { BasaltError } from '@basaltkit/core'

/**
 * Custom-domain management for tenants. The framework already *resolves* a custom
 * domain to a tenant (`domainResolver` + `TenantSource.findByDomain`); this adds
 * the layer around it — register a domain, prove ownership with a DNS TXT record,
 * and only let **verified** domains resolve. (TLS certificate provisioning is
 * infrastructure and out of scope.)
 */
/** Strip trailing '.' without a backtracking regex (avoids ReDoS on long runs). */
function stripTrailingDots(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 46 /* '.' */) end--
  return s.slice(0, end)
}

export interface CustomDomain {
  domain: string
  tenantId: string
  verified: boolean
  /** Random value the tenant publishes in DNS to prove ownership. */
  verificationToken: string
  createdAt: number
  verifiedAt?: number
}

/** RFC 1123 label: 1-63 of [a-z0-9-], not starting or ending with '-'. Bounded, no backtracking. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const PORT = /^[0-9]{1,5}$/
const ALL_DIGITS = /^[0-9]+$/
/** A DNS name is at most 253 characters without its trailing dot. */
const MAX_HOSTNAME = 253

/**
 * Canonicalize a domain/Host value, or return `null` when it is not a hostname.
 *
 * Lowercases, trims, strips an optional `:port` and trailing dots, then holds
 * what is left to the RFC 1123 hostname grammar: dot-separated labels of
 * `[a-z0-9-]`, at most 253 characters, with a last label that is not all
 * digits. Anything else is **rejected, not rewritten** — userinfo
 * (`acme.app.com@evil.com`), a path, percent-encoding, full-width or other
 * non-ASCII characters, IPv4/IPv6 literals. A URL parser would "helpfully" turn
 * several of those into a *different* host than the one a proxy, WAF or cache
 * in front of the app routed on.
 *
 * Internationalized domains must be given in their ASCII (`xn--`) form, which is
 * what browsers send in `Host`; convert user input with `domainToASCII()` from
 * `node:url` before registering it.
 */
export function tryNormalizeDomain(input: string): string | null {
  if (typeof input !== 'string') return null
  let host = input.trim().toLowerCase()
  const colon = host.indexOf(':')
  if (colon !== -1) {
    // One optional numeric port; a second ':' means an IPv6 literal or garbage.
    if (!PORT.test(host.slice(colon + 1))) return null
    host = host.slice(0, colon)
  }
  host = stripTrailingDots(host) // FQDN form (`victim.com.`) and `com..` — idempotent
  if (host.length === 0 || host.length > MAX_HOSTNAME) return null
  const labels = host.split('.')
  for (const label of labels) if (!LABEL.test(label)) return null
  // `127.0.0.1`, `0x7f.1`, `2130706433`: an IP form, never a tenant's domain.
  if (ALL_DIGITS.test(labels[labels.length - 1]!)) return null
  return host
}

/**
 * Canonicalize a domain/Host value: lowercase, trim, strip a trailing dot and any
 * port. One function used by registration, verification, lookup AND the
 * Host-header resolver, so a domain always keys the same regardless of how it
 * was typed or presented (`Victim.com`, `victim.com.`, `victim.com:443`).
 *
 * Throws {@link InvalidDomainError} (400) for a value that is not a hostname —
 * see {@link tryNormalizeDomain} for the grammar. Use `tryNormalizeDomain` where
 * an invalid value should simply not match (the resolvers do).
 */
export function normalizeDomain(input: string): string {
  const host = tryNormalizeDomain(input)
  if (host === null) throw new InvalidDomainError(input)
  return host
}

/** Whether `domain` equals `base` or is a subdomain of it (both normalized). */
function isWithin(domain: string, base: string): boolean {
  return domain === base || domain.endsWith(`.${base}`)
}

export interface DomainStore {
  /** Insert a NEW domain. Must reject (throw) if the domain already exists — the uniqueness gate. */
  add(domain: CustomDomain): Promise<void>
  get(domain: string): Promise<CustomDomain | null>
  forTenant(tenantId: string): Promise<CustomDomain[]>
  markVerified(domain: string, at: number): Promise<void>
  markUnverified(domain: string): Promise<void>
  remove(domain: string): Promise<void>
  /**
   * Atomically swap the record for `expected.domain` with `next`, but ONLY if the
   * stored record is still `expected` (same tenant, token and verified flag).
   * Returns false when the record changed underneath. Used to hand an expired or
   * DNS-contested unverified claim to another tenant. Optional: without it the
   * swap is a remove followed by an add, which a concurrent claim can race.
   */
  replace?(expected: CustomDomain, next: CustomDomain): Promise<boolean>
}

export class MemoryDomainStore implements DomainStore {
  private readonly domains = new Map<string, CustomDomain>()
  async add(domain: CustomDomain): Promise<void> {
    // Atomic uniqueness: reject a duplicate rather than overwrite (last-writer-wins
    // would let a second tenant silently steal a domain). Durable stores MUST back
    // this with a UNIQUE constraint / conditional insert.
    if (this.domains.has(domain.domain)) throw new DomainTakenError(domain.domain)
    this.domains.set(domain.domain, { ...domain })
  }
  async get(domain: string): Promise<CustomDomain | null> {
    const found = this.domains.get(domain)
    return found ? { ...found } : null
  }
  async forTenant(tenantId: string): Promise<CustomDomain[]> {
    return [...this.domains.values()].filter((d) => d.tenantId === tenantId).map((d) => ({ ...d }))
  }
  async markVerified(domain: string, at: number): Promise<void> {
    const found = this.domains.get(domain)
    if (found) {
      found.verified = true
      found.verifiedAt = at
    }
  }
  async markUnverified(domain: string): Promise<void> {
    const found = this.domains.get(domain)
    if (found) {
      found.verified = false
      delete found.verifiedAt
    }
  }
  async remove(domain: string): Promise<void> {
    this.domains.delete(domain)
  }
  async replace(expected: CustomDomain, next: CustomDomain): Promise<boolean> {
    const current = this.domains.get(expected.domain)
    if (!current || !sameClaim(current, expected)) return false
    this.domains.delete(expected.domain)
    this.domains.set(next.domain, { ...next })
    return true
  }
}

function sameClaim(a: CustomDomain, b: CustomDomain): boolean {
  return a.tenantId === b.tenantId && a.verificationToken === b.verificationToken && a.verified === b.verified
}

export class DomainTakenError extends BasaltError {
  readonly status = 409
  constructor(domain: string) {
    super('DOMAIN_TAKEN', `Domain "${domain}" is already registered.`)
  }
}

export class DomainNotFoundError extends BasaltError {
  readonly status = 404
  constructor(domain: string) {
    super('DOMAIN_NOT_FOUND', `Domain "${domain}" is not registered.`)
  }
}

/** A value that is not a hostname (userinfo, path, `%`, non-ASCII, IP literal…). */
export class InvalidDomainError extends BasaltError {
  readonly status = 400
  constructor(domain: unknown) {
    const shown = typeof domain === 'string' ? JSON.stringify(domain.slice(0, 80)) : typeof domain
    super('DOMAIN_INVALID', `Invalid domain ${shown}. Expected a hostname such as "app.acme.com".`)
  }
}

/** The platform's own domain (or a subdomain of it) cannot be claimed as a custom domain. */
export class DomainReservedError extends BasaltError {
  readonly status = 403
  constructor(domain: string) {
    super('DOMAIN_RESERVED', `Domain "${domain}" is reserved by the platform and cannot be registered.`)
  }
}

/** A tenant tried to act on a domain that belongs to a different tenant. */
export class DomainForbiddenError extends BasaltError {
  readonly status = 403
  constructor(domain: string) {
    super('DOMAIN_FORBIDDEN', `Domain "${domain}" belongs to another tenant.`)
  }
}

const TXT_PREFIX = 'basalt-domain-verify='

/** The DNS record a tenant must publish to verify ownership. */
export interface DnsVerification {
  type: 'TXT'
  host: string
  value: string
}

export interface CustomDomainsOptions {
  store?: DomainStore
  now?: () => number
  /** Token generator (tests). Default: 24 random bytes, base64url. */
  token?: () => string
  /** DNS TXT resolver (tests). Default: `node:dns/promises` resolveTxt. */
  resolveTxt?: (hostname: string) => Promise<string[][]>
  /**
   * How long an UNVERIFIED claim holds a domain, in milliseconds. Default 72 h.
   *
   * A claim costs nothing but a sign-up, so without an expiry any tenant could
   * register a domain it does not own and block the real owner forever. Once a
   * claim is older than this and still unverified, another tenant's `add()`
   * takes the domain over. Verified domains never expire. `Infinity` disables
   * expiry (not recommended).
   */
  claimTtlMs?: number
  /**
   * The platform's own domains — e.g. `['basalt.app']`. Each one and every
   * subdomain of it is refused by `add()` with `DomainReservedError`: tenant
   * subdomains are assigned by the platform (`subdomainResolver`), never claimed
   * through custom domains. Default: none — set it to your apex.
   */
  reservedDomains?: string[]
  /**
   * Secret that derives a tenant's DNS challenge for a domain someone else holds
   * unverified (`challenge()`), so that **the verified TXT wins**: once the real
   * owner publishes it, their `add()` takes the domain over immediately instead
   * of waiting for the squatter's claim to expire. Keep it stable and identical
   * across instances. Without it, contested domains are freed only by expiry.
   */
  challengeSecret?: string
}

/** 72 hours. */
export const DEFAULT_CLAIM_TTL_MS = 72 * 60 * 60 * 1000

export class CustomDomains {
  private readonly store: DomainStore
  private readonly now: () => number
  private readonly token: () => string
  private readonly resolveTxt: (hostname: string) => Promise<string[][]>
  private readonly claimTtlMs: number
  private readonly reserved: string[]
  private readonly challengeSecret: string | undefined

  constructor(options: CustomDomainsOptions = {}) {
    this.store = options.store ?? new MemoryDomainStore()
    this.now = options.now ?? (() => Date.now())
    this.token = options.token ?? (() => randomBytes(24).toString('base64url'))
    this.resolveTxt = options.resolveTxt ?? dnsResolveTxt
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS
    // Normalized at boot: a malformed reserved domain is a config error, not a silent no-op.
    this.reserved = (options.reservedDomains ?? []).map((d) => normalizeDomain(d))
    this.challengeSecret = options.challengeSecret
  }

  /** The `_basalt-verify.<domain>` TXT host + expected value for a token. */
  private dns(domain: string, token: string): DnsVerification {
    return { type: 'TXT', host: `_basalt-verify.${domain}`, value: `${TXT_PREFIX}${token}` }
  }

  /** Load a record for a tenant, asserting ownership. Throws if missing/other tenant. */
  private async owned(tenantId: string, domain: string): Promise<CustomDomain> {
    const normalized = normalizeDomain(domain)
    const record = await this.store.get(normalized)
    if (!record) throw new DomainNotFoundError(normalized)
    if (record.tenantId !== tenantId) throw new DomainForbiddenError(normalized)
    return record
  }

  /**
   * Register a domain for a tenant (unverified). Returns it plus the DNS record to publish.
   *
   * Refuses a value that is not a hostname (`InvalidDomainError`) and the
   * platform's own domains (`DomainReservedError`). A domain another tenant
   * holds is refused with `DomainTakenError` — unless that claim is unverified
   * and either older than `claimTtlMs`, or the caller has already published its
   * {@link challenge} TXT record (then the caller gets it, verified).
   */
  async add(tenantId: string, domain: string): Promise<{ record: CustomDomain; dns: DnsVerification }> {
    const normalized = normalizeDomain(domain)
    const reserved = this.reserved.find((base) => isWithin(normalized, base))
    if (reserved) throw new DomainReservedError(normalized)
    const record: CustomDomain = {
      domain: normalized,
      tenantId,
      verified: false,
      verificationToken: this.token(),
      createdAt: this.now(),
    }
    try {
      // store.add is the atomic uniqueness gate (throws DomainTakenError on conflict);
      // no check-then-act TOCTOU window here.
      await this.store.add(record)
      return { record, dns: this.dns(normalized, record.verificationToken) }
    } catch (error) {
      if (!(error instanceof DomainTakenError)) throw error
      const taken = await this.takeOver(tenantId, normalized, record)
      if (!taken) throw error
      return { record: taken, dns: this.dns(normalized, taken.verificationToken) }
    }
  }

  /**
   * The DNS record `tenantId` publishes to prove it owns `domain` while another
   * tenant holds an unverified claim on it. Once it resolves, `add()` hands the
   * domain over. Requires `challengeSecret`.
   */
  challenge(tenantId: string, domain: string): DnsVerification {
    const normalized = normalizeDomain(domain)
    return this.dns(normalized, this.challengeToken(tenantId, normalized))
  }

  private challengeToken(tenantId: string, domain: string): string {
    if (!this.challengeSecret) {
      throw new Error('CustomDomains.challenge() requires the `challengeSecret` option.')
    }
    return createHmac('sha256', this.challengeSecret).update(`${tenantId}\n${domain}`).digest('base64url')
  }

  /**
   * Hand an existing claim to `tenantId` when it is unverified AND either
   * expired or contested by a DNS record proving `tenantId` controls the domain.
   * Returns the new record, or null when the claim stands.
   */
  private async takeOver(tenantId: string, domain: string, fresh: CustomDomain): Promise<CustomDomain | null> {
    const existing = await this.store.get(domain)
    if (!existing || existing.verified || existing.tenantId === tenantId) return null
    let next: CustomDomain | null = null
    if (this.challengeSecret) {
      // The verified TXT wins: DNS control is what ownership means here.
      const token = this.challengeToken(tenantId, domain)
      if (await this.hasTxt(domain, token)) {
        const at = this.now()
        next = { domain, tenantId, verified: true, verificationToken: token, createdAt: at, verifiedAt: at }
      }
    }
    if (!next && this.now() - existing.createdAt >= this.claimTtlMs) next = fresh
    if (!next) return null
    if (this.store.replace) return (await this.store.replace(existing, next)) ? next : null
    await this.store.remove(domain)
    await this.store.add(next) // a concurrent claim may win here; it then throws DomainTakenError
    return next
  }

  private async hasTxt(domain: string, token: string): Promise<boolean> {
    const txts = await this.resolveTxt(`_basalt-verify.${domain}`).catch(() => [] as string[][])
    return txts.map((chunks) => chunks.join('')).includes(`${TXT_PREFIX}${token}`)
  }

  /** The DNS record for one of the tenant's OWN domains (to show them again). */
  async instructions(tenantId: string, domain: string): Promise<DnsVerification> {
    const record = await this.owned(tenantId, domain)
    return this.dns(record.domain, record.verificationToken)
  }

  /**
   * Check the TXT record for one of the tenant's OWN domains and (un)mark it
   * verified. Already-verified domains short-circuit unless `force` is set — pass
   * `force` on a schedule to catch a domain whose DNS was later removed/repointed
   * (defence against dangling-domain takeover); on a failed re-check it is
   * un-verified so it stops resolving.
   */
  async verify(tenantId: string, domain: string, options: { force?: boolean } = {}): Promise<boolean> {
    const record = await this.owned(tenantId, domain)
    if (record.verified && !options.force) return true
    if (await this.hasTxt(record.domain, record.verificationToken)) {
      if (!record.verified) await this.store.markVerified(record.domain, this.now())
      return true
    }
    if (record.verified) await this.store.markUnverified(record.domain) // revoke on failed re-check
    return false
  }

  async list(tenantId: string): Promise<CustomDomain[]> {
    return this.store.forTenant(tenantId)
  }

  /** Remove one of the tenant's OWN domains (asserts ownership first). */
  async remove(tenantId: string, domain: string): Promise<void> {
    const record = await this.owned(tenantId, domain)
    await this.store.remove(record.domain)
  }

  /** The tenant id a **verified** domain maps to — wire this into `TenantSource.findByDomain`. */
  async tenantOf(domain: string): Promise<string | null> {
    const normalized = tryNormalizeDomain(domain)
    if (normalized === null) return null
    const record = await this.store.get(normalized)
    return record?.verified ? record.tenantId : null
  }
}

/**
 * Build a `findByDomain` that resolves ONLY verified custom domains, by looking
 * the domain up via {@link CustomDomains.tenantOf} then loading the tenant. Wire
 * this into your `TenantSource` so a forged/unverified Host header can never
 * resolve to a tenant:
 *
 * ```ts
 * const source: TenantSource = {
 *   find: (id) => db.tenant.find(id),
 *   findByDomain: findByVerifiedDomain(customDomains, (id) => db.tenant.find(id)),
 * }
 * ```
 */
export function findByVerifiedDomain<T>(
  customDomains: CustomDomains,
  find: (tenantId: string) => Promise<T | null>,
): (domain: string) => Promise<T | null> {
  return async (domain: string) => {
    const tenantId = await customDomains.tenantOf(domain)
    return tenantId ? find(tenantId) : null
  }
}
