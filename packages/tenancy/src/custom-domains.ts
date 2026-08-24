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

export interface DomainStore {
  add(domain: CustomDomain): Promise<void>
  get(domain: string): Promise<CustomDomain | null>
  forTenant(tenantId: string): Promise<CustomDomain[]>
  markVerified(domain: string, at: number): Promise<void>
  remove(domain: string): Promise<void>
}

export class MemoryDomainStore implements DomainStore {
  private readonly domains = new Map<string, CustomDomain>()
  async add(domain: CustomDomain): Promise<void> {
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

  /** Register a domain for a tenant (unverified). Returns it plus the DNS record to publish. */
  async add(tenantId: string, domain: string): Promise<{ record: CustomDomain; dns: DnsVerification }> {
    const normalized = domain.trim().toLowerCase()
    if (await this.store.get(normalized)) throw new DomainTakenError(normalized)
    const record: CustomDomain = {
      domain: normalized,
      tenantId,
      verified: false,
      verificationToken: this.token(),
      createdAt: this.now(),
    }
    await this.store.add(record)
    return { record, dns: this.dns(normalized, record.verificationToken) }
  }

  /** The DNS record for an existing domain (to show the tenant again). */
  async instructions(domain: string): Promise<DnsVerification> {
    const record = await this.store.get(domain)
    if (!record) throw new DomainNotFoundError(domain)
    return this.dns(record.domain, record.verificationToken)
  }

  /** Check the TXT record and mark the domain verified if it matches. */
  async verify(domain: string): Promise<boolean> {
    const record = await this.store.get(domain)
    if (!record) throw new DomainNotFoundError(domain)
    if (record.verified) return true
    const txts = await this.resolveTxt(`_basalt-verify.${record.domain}`).catch(() => [] as string[][])
    const values = txts.map((chunks) => chunks.join(''))
    if (values.includes(`${TXT_PREFIX}${record.verificationToken}`)) {
      await this.store.markVerified(record.domain, this.now())
      return true
    }
    return false
  }

  async list(tenantId: string): Promise<CustomDomain[]> {
    return this.store.forTenant(tenantId)
  }
  async remove(domain: string): Promise<void> {
    await this.store.remove(domain)
  }

  /** The tenant id a **verified** domain maps to — wire this into `TenantSource.findByDomain`. */
  async tenantOf(domain: string): Promise<string | null> {
    const record = await this.store.get(domain.trim().toLowerCase())
    return record?.verified ? record.tenantId : null
  }
}
