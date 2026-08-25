import { randomBytes } from 'node:crypto'
import { resolveTxt as dnsResolveTxt } from 'node:dns/promises'
import { BasaltError } from '@basaltkit/core'

/**
 * Custom-domain management for tenants. The framework already *resolves* a custom
 * domain to a tenant (`domainResolver` + `TenantSource.findByDomain`); this adds
 * the layer around it — register a domain, prove ownership with a DNS TXT record,
 * and only let **verified** domains resolve. (TLS certificate provisioning is
 * infrastructure and out of scope.)
 */
export interface CustomDomain {
  domain: string
  tenantId: string
  verified: boolean
  /** Random value the tenant publishes in DNS to prove ownership. */
  verificationToken: string
  createdAt: number
  verifiedAt?: number
}

/**
 * Canonicalize a domain/Host value: lowercase, trim, strip a trailing dot and any
 * port, and IDNA/punycode-encode unicode. One function used by registration,
 * verification, lookup AND the Host-header resolver, so a domain always keys the
 * same regardless of how it was typed or presented (`Victim.com`, `victim.com.`,
 * `victim.com:443`, unicode homographs).
 */
export function normalizeDomain(input: string): string {
  let host = input.trim().toLowerCase()
  if (host.startsWith('[')) host = host.slice(1, host.indexOf(']') > 0 ? host.indexOf(']') : undefined) // IPv6
  else host = host.split(':')[0] ?? host // strip port
  host = host.replace(/\.+$/, '') // strip ALL trailing dots (FQDN form / `com..`) — idempotent
  try {
    // URL applies IDNA (unicode → punycode ASCII); guards against homograph tricks.
    return new URL(`http://${host}`).hostname
  } catch {
    return host
  }
}

export interface DomainStore {
  /** Insert a NEW domain. Must reject (throw) if the domain already exists — the uniqueness gate. */
  add(domain: CustomDomain): Promise<void>
  get(domain: string): Promise<CustomDomain | null>
  forTenant(tenantId: string): Promise<CustomDomain[]>
  markVerified(domain: string, at: number): Promise<void>
  markUnverified(domain: string): Promise<void>
  remove(domain: string): Promise<void>
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
}

export class CustomDomains {
  private readonly store: DomainStore
  private readonly now: () => number
  private readonly token: () => string
  private readonly resolveTxt: (hostname: string) => Promise<string[][]>

  constructor(options: CustomDomainsOptions = {}) {
    this.store = options.store ?? new MemoryDomainStore()
    this.now = options.now ?? (() => Date.now())
    this.token = options.token ?? (() => randomBytes(24).toString('base64url'))
    this.resolveTxt = options.resolveTxt ?? dnsResolveTxt
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

  /** Register a domain for a tenant (unverified). Returns it plus the DNS record to publish. */
  async add(tenantId: string, domain: string): Promise<{ record: CustomDomain; dns: DnsVerification }> {
    const normalized = normalizeDomain(domain)
    const record: CustomDomain = {
      domain: normalized,
      tenantId,
      verified: false,
      verificationToken: this.token(),
      createdAt: this.now(),
    }
    // store.add is the atomic uniqueness gate (throws DomainTakenError on conflict);
    // no check-then-act TOCTOU window here.
    await this.store.add(record)
    return { record, dns: this.dns(normalized, record.verificationToken) }
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
    const txts = await this.resolveTxt(`_basalt-verify.${record.domain}`).catch(() => [] as string[][])
    const values = txts.map((chunks) => chunks.join(''))
    if (values.includes(`${TXT_PREFIX}${record.verificationToken}`)) {
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
    const record = await this.store.get(normalizeDomain(domain))
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
