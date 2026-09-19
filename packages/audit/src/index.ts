import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createToken, definePlugin, ensureMetadata, tryCtx, type RequestContext } from '@basaltkit/core'
import { EVENTS } from '@basaltkit/events'
import {
  AUDIT_CHAIN_GENESIS,
  AuditChainConflictError,
  assertIntegrityKey,
  auditChainKey,
  type AuditIntegrityKey,
  computeAuditHash,
  parseAuditChainKey,
} from './chain.js'

export * from './chain.js'

declare module '@basaltkit/core' {
  interface RequestContext {
    /**
     * Client information of the current HTTP request, set by `auditPlugin({ requestContext: true })`
     * through an `http:enrichers` entry (so every adapter — fastify, express, hono — provides it).
     */
    client?: { ip?: string | undefined; userAgent?: string | undefined }
  }
}

/** One immutable line of the trail. */
export interface AuditEntry {
  readonly id: string
  /** Where it came from: a lifecycle hook, a domain event or a manual record. */
  readonly source: 'hook' | 'event' | 'manual'
  readonly event: string
  readonly payload: unknown
  /** Enriched from the ALS context at record time. */
  readonly actorId?: string | undefined
  readonly tenantId?: string | undefined
  readonly requestId?: string | undefined
  /** Client IP of the originating HTTP request (opt-in, PII — see `requestContext`). */
  readonly ip?: string | undefined
  /** User-agent of the originating HTTP request (opt-in, truncated to 512 chars). */
  readonly userAgent?: string | undefined
  readonly at: number
  /** Position in the tenant's hash chain (from 1). Absent on unchained entries. */
  readonly seq?: number | undefined
  /** `hash` of the previous entry in the chain ({@link AUDIT_CHAIN_GENESIS} for the first). */
  readonly prevHash?: string | undefined
  /** SHA-256 (or HMAC-SHA256) over `prevHash` + the canonical entry — see `computeAuditHash`. */
  readonly hash?: string | undefined
}

export interface AuditQuery {
  /** Wildcard pattern over the event name (e.g. 'auth:**'). */
  event?: string
  tenantId?: string
  actorId?: string
  since?: number
  limit?: number
}

/**
 * Throws unless `limit` is absent or a non-negative safe integer.
 *
 * `AuditQuery.limit` is typed `number`, but handlers routinely forward a raw
 * query-string value; a driver that builds SQL from it must never receive a
 * string. {@link Audit} validates every read, and the bundled drivers validate
 * again so a store called directly is equally safe.
 */
export function assertAuditLimit(limit: unknown): asserts limit is number | undefined {
  if (limit === undefined) return
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) {
    throw new TypeError('AuditQuery.limit must be a non-negative safe integer')
  }
}

/** The latest entry of a hash chain. */
export interface AuditChainHead {
  seq: number
  hash: string
}

/** A window of a hash chain, inclusive on both ends, read in ascending `seq` order. */
export interface AuditChainRange {
  fromSeq: number
  toSeq?: number | undefined
  limit: number
}

/**
 * Append-only by contract: no update, no delete.
 *
 * The chain methods are optional — a store without them works exactly as before,
 * but cannot back `integrity: 'hash-chain'`. A store that implements them MUST
 * also reject an `append` whose `(auditChainKey(tenantId), seq)` already exists
 * with {@link AuditChainConflictError} (a unique constraint in SQL): that is what
 * keeps concurrent writers on several replicas from forking a chain.
 */
export interface AuditStore {
  append(entry: AuditEntry): Promise<void>
  query(query: AuditQuery): Promise<AuditEntry[]>
  /** Latest chained entry of the tenant's chain (`undefined` tenant = system chain). */
  chainHead?(tenantId: string | undefined): Promise<AuditChainHead | undefined>
  /** Chained entries of one chain with `fromSeq <= seq <= toSeq`, ascending, at most `limit`. */
  readChain?(tenantId: string | undefined, range: AuditChainRange): Promise<AuditEntry[]>
  /** Rows of the tenant (`undefined` = no tenant) written without a chain (before integrity was on). */
  countUnchained?(tenantId: string | undefined): Promise<number>
  /** Tenants that have a chain (`undefined` = the system chain). */
  chainTenants?(): Promise<Array<string | undefined>>
}

export class MemoryAuditStore implements AuditStore {
  private readonly entries: AuditEntry[] = []
  /** `(chain, seq)` pairs taken — the in-memory equivalent of the SQL unique index. */
  private readonly chainSlots = new Set<string>()

  async append(entry: AuditEntry): Promise<void> {
    if (entry.seq !== undefined) {
      const slot = `${auditChainKey(entry.tenantId)}#${entry.seq}`
      if (this.chainSlots.has(slot)) throw new AuditChainConflictError(entry.tenantId, entry.seq)
      this.chainSlots.add(slot)
    }
    this.entries.push(Object.freeze({ ...entry }))
  }

  async chainHead(tenantId: string | undefined): Promise<AuditChainHead | undefined> {
    let head: AuditChainHead | undefined
    for (const e of this.entries) {
      if (e.seq === undefined || e.hash === undefined || e.tenantId !== tenantId) continue
      if (head === undefined || e.seq > head.seq) head = { seq: e.seq, hash: e.hash }
    }
    return head
  }

  async readChain(tenantId: string | undefined, range: AuditChainRange): Promise<AuditEntry[]> {
    return this.entries
      .filter((e) => e.seq !== undefined && e.tenantId === tenantId && e.seq >= range.fromSeq && (range.toSeq === undefined || e.seq <= range.toSeq))
      .sort((a, b) => a.seq! - b.seq!) // stable: ties keep insertion order
      .slice(0, range.limit)
  }

  async countUnchained(tenantId: string | undefined): Promise<number> {
    return this.entries.filter((e) => e.seq === undefined && e.tenantId === tenantId).length
  }

  async chainTenants(): Promise<Array<string | undefined>> {
    const keys = new Set(this.entries.filter((e) => e.seq !== undefined).map((e) => auditChainKey(e.tenantId)))
    return [...keys].map(parseAuditChainKey)
  }

  async query(query: AuditQuery): Promise<AuditEntry[]> {
    assertAuditLimit(query.limit)
    let results = this.entries.filter(
      (entry) =>
        (query.event === undefined || patternMatches(query.event, entry.event)) &&
        (query.tenantId === undefined || entry.tenantId === query.tenantId) &&
        (query.actorId === undefined || entry.actorId === query.actorId) &&
        (query.since === undefined || entry.at >= query.since),
    )
    results = [...results].reverse() // newest first
    return query.limit !== undefined ? results.slice(0, query.limit) : results
  }
}

/**
 * Wildcard matcher over ':' and '.' segments: 'auth:**' matches 'auth:login',
 * 'order.*' matches 'order.created', '**' matches everything.
 */
export function patternMatches(pattern: string, name: string): boolean {
  if (pattern === name || pattern === '**') return true
  const split = (value: string) => value.split(/[.:]/)
  const patternSegments = split(pattern)
  const nameSegments = split(name)
  for (let i = 0; i < patternSegments.length; i++) {
    const segment = patternSegments[i]
    if (segment === '**') return i < nameSegments.length
    if (i >= nameSegments.length) return false
    if (segment !== '*' && segment !== nameSegments[i]) return false
  }
  return patternSegments.length === nameSegments.length
}

/** How deep the redactors walk a payload before dropping the rest. */
const MAX_REDACT_DEPTH = 6
/** Stand-in for a subtree deeper than {@link MAX_REDACT_DEPTH}. */
const TRUNCATED = '[truncated]'

/**
 * The event filter a driver may push into SQL as an equality. A pattern with a
 * wildcard must still be matched in code; so must one containing `.`, because
 * {@link patternMatches} treats `.` and `:` as interchangeable separators and an
 * equality would miss `a:b` for the pattern `a.b`.
 */
export function exactEventMatch(pattern: string | undefined): string | undefined {
  if (pattern === undefined) return undefined
  return /[*.]/.test(pattern) ? undefined : pattern
}

/**
 * Rows a driver reads per round-trip when a wildcard pattern forces a scan.
 * Bounds peak memory: a limited query no longer materialises the whole trail.
 */
export const AUDIT_SCAN_PAGE = 500

/** Object keys whose values are masked before an entry is persisted. */
const SENSITIVE_KEY = /pass(word|wd)?|secret|token|authorization|api[-_]?key|credential|cookie|session|otp|mfa/i

/** Recursively masks sensitive fields so secrets/PII never reach the trail. */
export function redactSensitive(value: unknown, depth = 0): unknown {
  // Past the depth bound the subtree is dropped, NOT passed through: event
  // payloads are arbitrary, and returning the raw value here let a secret nested
  // deeper than the limit reach the trail in cleartext.
  if (value === null || typeof value !== 'object') return value
  if (depth > MAX_REDACT_DEPTH) return TRUNCATED
  if (Array.isArray(value)) return value.map((v) => redactSensitive(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redactSensitive(v, depth + 1)
  }
  return out
}

export type AuditRedactor = (payload: unknown, event: string) => unknown

/** Default payload scrubber: masks common secret keys, ignoring the event name. */
export const defaultAuditRedactor: AuditRedactor = (payload) => redactSensitive(payload)

/** Object keys that commonly carry direct PII and can be pseudonymized on request. */
const PII_KEY = /e[-_]?mail|phone|msisdn|ssn|nif|taxid|passport/i
/**
 * Keys carrying an IP address (PII under GDPR). Anchored — a bare `/ip/` would
 * also match `zip`, `recipient` or `shipping`.
 */
const IP_KEY = /^(ip|ip[-_]?addr(ess)?|client[-_]?ip|remote[-_]?addr(ess)?|x[-_]?forwarded[-_]?for)$/i
/** A value that looks like an email address. */
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A pseudonymisation key: a secret of at least 128 bits (16 bytes). */
export type PseudonymizationKey = string | Uint8Array

/** Minimum key length in bytes (128 bits). */
const MIN_PSEUDONYM_KEY_BYTES = 16
/** Pseudonym length in hex chars: 128 bits of HMAC output. */
const PSEUDONYM_HEX_CHARS = 32

function assertPseudonymKey(key: PseudonymizationKey): void {
  // Type-checked at runtime too: a number or a `{ byteLength }` look-alike must
  // not pass configuration and then fail (or be coerced) on the first entry.
  if (typeof key !== 'string' && !(key instanceof Uint8Array)) {
    throw new TypeError('Audit pseudonymization key must be a string or a Uint8Array')
  }
  const bytes = typeof key === 'string' ? Buffer.byteLength(key) : key.byteLength
  if (bytes < MIN_PSEUDONYM_KEY_BYTES) {
    throw new TypeError(`Audit pseudonymization key must be at least ${MIN_PSEUDONYM_KEY_BYTES} bytes (128 bits)`)
  }
}

/**
 * Used when no key is configured. It is random per process, so an unkeyed
 * pseudonym is NOT reversible by brute force (an unkeyed hash of a phone number
 * or email is), at the cost of not correlating across restarts. Configure a key
 * for stable pseudonyms.
 */
let ephemeralKey: Buffer | undefined
let warnedUnkeyed = false
function warnUnkeyed(): void {
  warnedUnkeyed = true
  console.warn(
    '[basalt:audit] PII pseudonymization has no configured key: using a random per-process key, so pseudonyms ' +
      'will not correlate across restarts. Pass `createPiiMinimizingRedactor({ key })` with a secret of at least 128 bits.',
  )
}
function unkeyedFallback(): Buffer {
  if (!warnedUnkeyed) warnUnkeyed()
  return (ephemeralKey ??= randomBytes(32))
}

/**
 * Deterministically pseudonymizes a value with HMAC-SHA256 under `key`: the
 * same input and key always map to the same opaque 128-bit token, so records
 * stay correlatable without persisting the raw PII — and without the key the
 * token cannot be reversed by hashing candidate emails or phone numbers.
 *
 * Without a key a random per-process key is used (and a warning is logged once).
 */
export function pseudonymize(value: string, key?: PseudonymizationKey): string {
  if (key !== undefined) assertPseudonymKey(key)
  const digest = createHmac('sha256', key ?? unkeyedFallback()).update(value).digest('hex')
  return `pii_${digest.slice(0, PSEUDONYM_HEX_CHARS)}`
}

export interface PiiRedactionOptions {
  /** Secret used to key pseudonyms (>= 128 bits). Without it, see {@link pseudonymize}. */
  key?: PseudonymizationKey
}

/**
 * Recursively masks secrets (like {@link redactSensitive}) AND replaces obvious
 * PII — email/phone-shaped values, and values under common PII keys — with a
 * stable pseudonym. Use it to minimize PII at rest in the trail while keeping
 * entries correlatable.
 */
export function redactSensitiveAndPii(value: unknown, depth = 0, options: PiiRedactionOptions = {}): unknown {
  if (value === null) return value
  // Bound the length before the regex: a real email is <= 254 chars (RFC 5321),
  // so only test plausibly-email-length strings — arbitrary logged values never
  // reach the regex, avoiding ReDoS on attacker-influenceable input.
  if (typeof value === 'string')
    return value.length <= 320 && EMAIL_VALUE.test(value) ? pseudonymize(value, options.key) : value
  if (typeof value !== 'object') return value
  if (depth > MAX_REDACT_DEPTH) return TRUNCATED
  if (Array.isArray(value)) return value.map((v) => redactSensitiveAndPii(v, depth + 1, options))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) out[k] = '[redacted]'
    else if (PII_KEY.test(k) || IP_KEY.test(k)) out[k] = pseudonymizeAll(v, depth + 1, options)
    else out[k] = redactSensitiveAndPii(v, depth + 1, options)
  }
  return out
}

/**
 * Everything under a PII key is PII, whatever its shape: a numeric phone, a
 * list of emails or a `{ number, country }` object must not reach the trail raw.
 * Every scalar leaf is pseudonymized; secret-looking keys are still masked.
 */
function pseudonymizeAll(value: unknown, depth: number, options: PiiRedactionOptions): unknown {
  if (value === null || value === undefined || typeof value === 'boolean') return value
  if (typeof value === 'string') return pseudonymize(value, options.key)
  if (typeof value === 'number' || typeof value === 'bigint') return pseudonymize(String(value), options.key)
  if (typeof value !== 'object') return undefined
  if (depth > MAX_REDACT_DEPTH) return TRUNCATED
  if (Array.isArray(value)) return value.map((v) => pseudonymizeAll(v, depth + 1, options))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : pseudonymizeAll(v, depth + 1, options)
  }
  return out
}

/**
 * Payload scrubber that also pseudonymizes obvious PII (PII F3), keyed with
 * HMAC-SHA256. Opt-in — pass it to `auditPlugin({ redact: createPiiMinimizingRedactor({ key }) })`.
 * The key is validated up front (>= 128 bits); without one, pseudonyms use a
 * random per-process key and a warning is logged.
 *
 * TODO(PII F3 follow-up): the default capture set still persists whatever the
 * emitting code puts in the payload. A fuller minimization pass would let callers
 * declare per-event field policies; kept out of the default here to avoid changing
 * existing capture/redaction behavior.
 */
export function createPiiMinimizingRedactor(options: PiiRedactionOptions = {}): AuditRedactor {
  // Validate (or warn) at configuration time, not on the first captured entry.
  if (options.key !== undefined) assertPseudonymKey(options.key)
  else warnUnkeyed()
  return (payload) => redactSensitiveAndPii(payload, 0, options)
}

/**
 * Unkeyed PII redactor: pseudonyms use a random per-process key (not reversible,
 * not stable across restarts). Prefer {@link createPiiMinimizingRedactor} with a key.
 */
export const piiMinimizingRedactor: AuditRedactor = (payload) => redactSensitiveAndPii(payload)

/** Client information of the originating request. */
export interface AuditRequestInfo {
  ip?: string | undefined
  userAgent?: string | undefined
}

/** Resolves the request fields to record, from the active context (if any). */
export type AuditRequestContextResolver = (context: RequestContext | undefined) => AuditRequestInfo | undefined

/** `'hash-chain'` (SHA-256) or `{ mode: 'hash-chain', key }` (HMAC-SHA256 under a >=128-bit secret). */
export type AuditIntegrity = 'none' | 'hash-chain' | { mode: 'hash-chain'; key?: AuditIntegrityKey }

export interface AuditOptions {
  /**
   * `'hash-chain'` links every entry to the previous one of its tenant's chain
   * (`seq`, `prevHash`, `hash`) so {@link Audit.verify} can detect edited,
   * deleted, reordered or forged rows. Needs a store with the chain methods
   * (memory, `@basaltkit/audit-sqlite`, `@basaltkit/audit-prisma`). Default `'none'`.
   */
  integrity?: AuditIntegrity
  /**
   * Record the client `ip` / `userAgent` of the originating request. `true`
   * reads `ctx().client` (set by the plugin's HTTP enricher); a function resolves
   * them itself. Default off — an IP address is personal data: pair it with
   * `createPiiMinimizingRedactor` to store a pseudonym instead.
   */
  requestContext?: boolean | AuditRequestContextResolver
}

export interface AuditVerifyOptions {
  /**
   * The chain to verify. Inside a tenant context the context tenant is FORCED
   * (like {@link Audit.trail}); otherwise omitted = the system chain.
   */
  tenantId?: string
  /** First `seq` to check (inclusive, default 1). Anchored on the entry at `from - 1`. */
  from?: number
  /** Last `seq` to check (inclusive, default: the head). */
  to?: number
}

export type AuditVerifyFailure =
  | 'hash-mismatch'
  | 'prev-hash-mismatch'
  | 'sequence-gap'
  | 'sequence-duplicate'
  | 'missing-predecessor'

export interface AuditVerifyResult {
  ok: boolean
  /** The chain verified (`undefined` = system chain). */
  tenantId: string | undefined
  /** Chained entries that verified before the first failure (all of them when `ok`). */
  checked: number
  /** Rows of this tenant written without a chain (before integrity was enabled): not verifiable, not broken. */
  unchained: number
  /** `seq` of the first entry that failed. */
  firstBrokenAt?: number
  /** Id of the offending row, when there is one. */
  entryId?: string
  reason?: AuditVerifyFailure
  /** Last verified entry — record it outside the database to detect later truncation of the tail. */
  head?: AuditChainHead
}

export interface AuditVerifyAllResult {
  ok: boolean
  chains: AuditVerifyResult[]
}

/** Longest user-agent kept: the header is client-controlled and unbounded. */
const MAX_USER_AGENT = 512
/** Longest IP kept (an IPv6 literal with zone id fits comfortably). */
const MAX_IP = 64
/** Attempts to append after a `(chain, seq)` conflict before giving up. */
const MAX_CHAIN_ATTEMPTS = 10

const defaultRequestContext: AuditRequestContextResolver = (context) => context?.client

const clip = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined

type ChainStore = Required<Pick<AuditStore, 'chainHead' | 'readChain' | 'countUnchained' | 'chainTenants'>> & AuditStore

export class Audit {
  private readonly chainEnabled: boolean
  private readonly chainKey: AuditIntegrityKey | undefined
  private readonly requestContext: AuditRequestContextResolver | undefined
  /** Per-chain in-process mutex: appends to one chain run one at a time. */
  private readonly chainLocks = new Map<string, Promise<void>>()

  constructor(
    private readonly store: AuditStore,
    /** Scrubs each payload before it is stored. Default masks common secret keys. */
    private readonly redact: AuditRedactor = defaultAuditRedactor,
    /**
     * Whether the host app is multi-tenant, i.e. whether `@basaltkit/tenancy`
     * is registered. `auditPlugin` wires this to the container's
     * `'tenancy:active'` metadata marker; it is a *signal*, never an import —
     * `@basaltkit/audit` is a generic package and must not depend on tenancy.
     *
     * Defaults to `false`: a hand-built `new Audit(store)` behaves like a
     * single-tenant app, which is the only thing it can safely assume.
     */
    private readonly tenancyActive: () => boolean = () => false,
    options: AuditOptions = {},
  ) {
    const integrity = options.integrity ?? 'none'
    this.chainEnabled = integrity !== 'none'
    this.chainKey = typeof integrity === 'object' ? integrity.key : undefined
    if (typeof integrity === 'object' && integrity.mode !== 'hash-chain') {
      throw new TypeError(`Unknown audit integrity mode: ${String(integrity.mode)}`)
    }
    if (this.chainKey !== undefined) assertIntegrityKey(this.chainKey)
    if (this.chainEnabled && !isChainStore(store)) {
      throw new TypeError(
        "Audit integrity 'hash-chain' needs a store implementing chainHead/readChain/countUnchained/chainTenants " +
          '(MemoryAuditStore, @basaltkit/audit-sqlite or @basaltkit/audit-prisma).',
      )
    }
    this.requestContext =
      options.requestContext === true ? defaultRequestContext : options.requestContext || undefined
  }

  /** Manual entry — for actions no hook covers. */
  async record(event: string, payload?: unknown): Promise<AuditEntry> {
    return this.append(this.build('manual', event, payload))
  }

  /** @internal used by the plugin's hook/event taps. */
  async capture(source: 'hook' | 'event', event: string, payload: unknown): Promise<void> {
    await this.append(this.build(source, event, payload))
  }

  /**
   * Reads the audit trail — the everyday read.
   *
   * Tenant scoping (PII F2), applied only where a tenant dimension exists:
   * - When a tenant is present in the ambient context, the read is FORCED to
   *   that tenant. Any caller-supplied `query.tenantId` is ignored/overridden
   *   (the context tenant is spread LAST so it always wins), so a tenant-facing
   *   handler that forwards client input — e.g. `trail({ tenantId: req.query.tenantId })`
   *   — can never widen the scope and read another tenant's trail.
   * - With no tenant in context, an explicit single-tenant read
   *   (`trail({ tenantId })`) is honoured.
   * - With no tenant in context and no explicit `tenantId`, the behavior depends
   *   on whether the app is multi-tenant at all:
   *   - **Tenancy registered** (`@basaltkit/tenancy` present): the read is
   *     REFUSED. Returning every tenant's records must be a deliberate,
   *     system-only act via {@link systemTrail}, never the silent default.
   *   - **No tenancy** (single-tenant/non-SaaS app): there is no tenant
   *     dimension to scope to, so this is simply "read the trail" and returns
   *     the rows. `@basaltkit/audit` is a general-purpose package; it must work
   *     without the opt-in SaaS layer.
   */
  async trail(query: AuditQuery = {}): Promise<AuditEntry[]> {
    // Validate before any store sees it: a limit forwarded straight from a
    // request (a string, a float, a SQL fragment) must never reach a driver.
    assertAuditLimit(query.limit)
    const ctxTenantId = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    if (ctxTenantId !== undefined) {
      // Force the scope: spread the context tenant LAST so a differing
      // caller-supplied `tenantId` cannot override it.
      return this.store.query({ ...query, tenantId: ctxTenantId })
    }
    if (query.tenantId !== undefined) {
      // No context, but the caller explicitly pinned a single tenant.
      return this.store.query(query)
    }
    if (!this.tenancyActive()) {
      // Single-tenant app: no tenant dimension, so an unscoped read is correct
      // and is the everyday call. Nothing to widen — every entry is "ours".
      return this.store.query(query)
    }
    // Multi-tenant app with no tenant to scope to and no explicit tenant
    // pinned: refuse to silently return every tenant's records. Cross-tenant /
    // system reads go through systemTrail() so broad access is deliberate.
    throw new Error(
      'Audit.trail() requires a tenant in context or an explicit `tenantId`. ' +
        'For a deliberate system-wide, cross-tenant read use Audit.systemTrail().',
    )
  }

  /**
   * SYSTEM-ONLY escape hatch: reads across ALL tenants (or whatever
   * `query.tenantId` explicitly pins), bypassing the tenant auto-scoping that
   * {@link trail} enforces.
   *
   * This exists for trusted platform/admin tooling only. NEVER call it with, or
   * forward into it, client-controlled input — doing so re-opens the
   * cross-tenant data-exposure that {@link trail} closes.
   */
  async systemTrail(query: AuditQuery = {}): Promise<AuditEntry[]> {
    assertAuditLimit(query.limit)
    return this.store.query(query)
  }

  /**
   * Verifies one hash chain: recomputes every entry's hash and checks `seq`
   * continuity and the `prevHash` links. Tenant scoping mirrors {@link trail}:
   * inside a tenant context the context tenant is forced; otherwise `tenantId`
   * picks the chain, and omitting it verifies the system chain.
   *
   * Rows written before integrity was enabled carry no hash: they are counted as
   * `unchained`, never reported as broken. Truncating the tail of a chain leaves
   * no gap — compare `head` against a value recorded elsewhere to catch that.
   */
  async verify(options: AuditVerifyOptions = {}): Promise<AuditVerifyResult> {
    const ctxTenantId = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    return this.verifyChain(ctxTenantId ?? options.tenantId, options.from, options.to)
  }

  /**
   * SYSTEM-ONLY: verifies every chain in the store (each tenant plus the system
   * chain). Like {@link systemTrail}, for trusted tooling (`basalt audit:verify --all`).
   */
  async verifyAll(): Promise<AuditVerifyAllResult> {
    const store = this.chainStore()
    // The system chain first, then tenants in a stable order.
    const named = new Set((await store.chainTenants()).filter((t): t is string => t !== undefined))
    const tenants = [undefined, ...[...named].sort()]
    const chains: AuditVerifyResult[] = []
    for (const tenantId of tenants) chains.push(await this.verifyChain(tenantId))
    return { ok: chains.every((c) => c.ok), chains }
  }

  private async verifyChain(tenantId: string | undefined, from?: number, to?: number): Promise<AuditVerifyResult> {
    const store = this.chainStore()
    const fromSeq = from ?? 1
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) throw new TypeError('verify: `from` must be a positive integer')
    if (to !== undefined && (!Number.isSafeInteger(to) || to < fromSeq)) {
      throw new TypeError('verify: `to` must be an integer >= `from`')
    }
    const unchained = await store.countUnchained(tenantId)
    const result = (fields: Partial<AuditVerifyResult> & Pick<AuditVerifyResult, 'ok' | 'checked'>): AuditVerifyResult => ({
      tenantId,
      unchained,
      ...fields,
    })

    let prevHash = AUDIT_CHAIN_GENESIS
    if (fromSeq > 1) {
      const [anchor] = await store.readChain(tenantId, { fromSeq: fromSeq - 1, toSeq: fromSeq - 1, limit: 1 })
      if (anchor?.hash === undefined) return result({ ok: false, checked: 0, firstBrokenAt: fromSeq, reason: 'missing-predecessor' })
      prevHash = anchor.hash
    }

    let expected = fromSeq
    let checked = 0
    let head: AuditChainHead | undefined
    for (;;) {
      const page = await store.readChain(tenantId, { fromSeq: expected, toSeq: to, limit: AUDIT_SCAN_PAGE })
      for (const entry of page) {
        const broken = (reason: AuditVerifyFailure) =>
          result({ ok: false, checked, firstBrokenAt: expected, entryId: entry.id, reason, ...(head ? { head } : {}) })
        if (entry.seq !== expected) return broken(entry.seq! < expected ? 'sequence-duplicate' : 'sequence-gap')
        if (entry.prevHash !== prevHash) return broken('prev-hash-mismatch')
        if (entry.tenantId !== tenantId || entry.hash !== computeAuditHash(entry, this.chainKey)) return broken('hash-mismatch')
        prevHash = entry.hash
        head = { seq: entry.seq, hash: entry.hash }
        checked++
        expected++
      }
      if (page.length < AUDIT_SCAN_PAGE) break
    }
    return result({ ok: true, checked, ...(head ? { head } : {}) })
  }

  private chainStore(): ChainStore {
    if (!isChainStore(this.store)) {
      throw new TypeError('Audit.verify() needs a store implementing the hash-chain methods.')
    }
    return this.store
  }

  private async append(draft: AuditEntry): Promise<AuditEntry> {
    if (!this.chainEnabled) {
      await this.store.append(draft)
      return draft
    }
    const store = this.store as ChainStore
    return this.withChainLock(auditChainKey(draft.tenantId), async () => {
      for (let attempt = 1; ; attempt++) {
        const head = await store.chainHead(draft.tenantId)
        const linked = { ...draft, seq: (head?.seq ?? 0) + 1, prevHash: head?.hash ?? AUDIT_CHAIN_GENESIS }
        const entry = Object.freeze({ ...linked, hash: computeAuditHash(linked, this.chainKey) })
        try {
          await store.append(entry)
          return entry
        } catch (error) {
          // Another writer (a second replica) took this seq first: re-read the
          // head and link after its entry. Jittered backoff avoids lock-step.
          if (!(error instanceof AuditChainConflictError) || attempt >= MAX_CHAIN_ATTEMPTS) throw error
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 4 * attempt))
        }
      }
    })
  }

  private async withChainLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chainLocks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => (release = resolve))
    const tail = previous.then(() => current)
    this.chainLocks.set(key, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.chainLocks.get(key) === tail) this.chainLocks.delete(key)
    }
  }

  private build(source: AuditEntry['source'], event: string, payload: unknown): AuditEntry {
    const context = tryCtx()
    const user = context?.['user'] as { id?: string } | undefined
    const tenant = context?.['tenant'] as { id?: string } | undefined
    return Object.freeze({
      id: randomUUID(),
      source,
      event,
      payload: this.redact(payload, event),
      actorId: user?.id,
      tenantId: tenant?.id,
      requestId: context?.requestId,
      ...this.requestFields(context, event),
      at: Date.now(),
    })
  }

  /**
   * `ip` / `userAgent` of the originating request, bounded, then passed through
   * the configured redactor as `{ ip, userAgent }` — so the PII-minimizing
   * redactor stores a pseudonym for the IP. A redactor that drops them wins.
   */
  private requestFields(context: RequestContext | undefined, event: string): AuditRequestInfo {
    if (this.requestContext === undefined) return {}
    const info = this.requestContext(context)
    const ip = clip(info?.ip, MAX_IP)
    const userAgent = clip(info?.userAgent, MAX_USER_AGENT)
    if (ip === undefined && userAgent === undefined) return {}
    const scrubbed = this.redact({ ...(ip ? { ip } : {}), ...(userAgent ? { userAgent } : {}) }, event)
    if (scrubbed === null || typeof scrubbed !== 'object') return {}
    const out = scrubbed as Record<string, unknown>
    const fields: AuditRequestInfo = {}
    if (typeof out['ip'] === 'string') fields.ip = out['ip']
    if (typeof out['userAgent'] === 'string') fields.userAgent = out['userAgent']
    return fields
  }
}

function isChainStore(store: AuditStore): store is ChainStore {
  return (
    typeof store.chainHead === 'function' &&
    typeof store.readChain === 'function' &&
    typeof store.countUnchained === 'function' &&
    typeof store.chainTenants === 'function'
  )
}

export const AUDIT = createToken<Audit>('audit')

export interface AuditPluginOptions {
  store?: AuditStore
  /**
   * Lifecycle hook patterns to record automatically.
   * Default: auth, billing, tenancy and permission activity.
   */
  hooks?: string[]
  /**
   * Domain event patterns recorded from the EventBus (when present).
   * Default: everything. Pass [] to disable.
   */
  events?: string[]
  /**
   * Scrubs each payload before it is stored. Defaults to masking common secret
   * keys (password, token, secret, authorization, api-key, …). Pass a custom
   * function to change the policy, or `(p) => p` to store payloads verbatim.
   */
  redact?: AuditRedactor

  /**
   * Called when a *bridged* capture fails — a hook or event the plugin picked
   * up automatically. Defaults to logging.
   *
   * The bridge is opportunistic: it must never fail (or slow down) the domain
   * write that emitted the hook, the same rule `@basaltkit/realtime` applies to
   * its own bridge. A deliberate `audit.record()` still throws, because there
   * the audit *is* the operation.
   *
   * The default logs rather than staying quiet: a trail with a silent hole is
   * worse than no trail, because it looks complete.
   */
  onCaptureError?: (error: unknown, info: { source: 'hook' | 'event'; event: string }) => void

  /**
   * `'hash-chain'` makes the trail verifiable: every entry is linked to the
   * previous one of its tenant's chain, `audit.verify()` detects tampering, and
   * the `audit:verify` CLI command is registered. See {@link AuditOptions.integrity}.
   */
  integrity?: AuditIntegrity

  /**
   * Record the client `ip` and `userAgent`. `true` registers an HTTP enricher
   * (works on every adapter) that puts them in `ctx().client`; a function
   * resolves them from the context itself. Off by default — IP is PII.
   */
  requestContext?: boolean | AuditRequestContextResolver
}

/**
 * `tenancy:created` and not `tenancy:**`.
 *
 * `tenancy:switched` fires on every HTTP request that resolves a tenant, so
 * capturing it by default wrote one audit row per request, forever — a
 * compliance trail drowned in routing noise.
 *
 * Worse, it also fires *inside* the new tenant's context during
 * `provision()`, before the tenant's storage exists. With a store bound to the
 * tenant's own database that write failed, the error propagated out through
 * `provision()`, and the tenant was marked failed: an application on the
 * default configuration could not create a single tenant.
 *
 * Tenant lifecycle is worth auditing; context switching is routing. The two
 * were only ever together because one wildcard covered both.
 */
const DEFAULT_HOOK_PATTERNS = ['auth:**', 'billing:**', 'tenancy:created', 'permission:**']

export function auditPlugin(options: AuditPluginOptions = {}) {
  const hookPatterns = options.hooks ?? DEFAULT_HOOK_PATTERNS
  const eventPatterns = options.events ?? ['**']
  const onCaptureError =
    options.onCaptureError ??
    ((error: unknown, info: { source: 'hook' | 'event'; event: string }) =>
      console.error(
        `[basalt:audit] capture failed for ${info.source} "${info.event}" — the operation continued, this entry is missing from the trail:`,
        error,
      ))

  return definePlugin({
    name: 'basalt:audit',
    register({ container, hooks }) {
      // The 'tenancy:active' marker is set by tenancyPlugin. Reading it here
      // (a string-keyed metadata bucket, not an import) is how a generic
      // package learns the app is multi-tenant without depending on
      // @basaltkit/tenancy — the same signal @basaltkit/cache uses. It is
      // resolved per call, so plugin registration order does not matter.
      const metadata = ensureMetadata(container)
      const tenancyActive = () => metadata.get('tenancy:active').length > 0
      const auditOptions: AuditOptions = {
        ...(options.integrity !== undefined ? { integrity: options.integrity } : {}),
        ...(options.requestContext !== undefined ? { requestContext: options.requestContext } : {}),
      }
      container.singleton(
        AUDIT,
        () =>
          new Audit(options.store ?? new MemoryAuditStore(), options.redact ?? defaultAuditRedactor, tenancyActive, auditOptions),
      )

      if (options.requestContext === true) {
        // A string-keyed metadata bucket, not an import of @basaltkit/http: the
        // neutral pipeline runs these enrichers for fastify, express and hono alike.
        metadata.add('http:enrichers', ({ request, context }: AuditHttpEnricherInfo) => {
          const header = request.headers['user-agent']
          context.client = { ip: request.ip, userAgent: Array.isArray(header) ? header[0] : header }
        })
      }

      if (options.integrity !== undefined && options.integrity !== 'none') {
        metadata.add('commands', createAuditVerifyCommand(() => container.get(AUDIT)))
      }

      hooks.onAny(async (hook, payload) => {
        if (!hookPatterns.some((pattern) => patternMatches(pattern, hook))) return
        try {
          await container.get(AUDIT).capture('hook', hook, payload)
        } catch (error) {
          onCaptureError(error, { source: 'hook', event: hook })
        }
      })
    },
    boot({ container }) {
      if (eventPatterns.length === 0 || !container.has(EVENTS)) return
      const bus = container.get(EVENTS)
      bus.on('**', async (payload, meta) => {
        if (!eventPatterns.some((pattern) => patternMatches(pattern, meta.name))) return
        try {
          await container.get(AUDIT).capture('event', meta.name, payload)
        } catch (error) {
          onCaptureError(error, { source: 'event', event: meta.name })
        }
      })
    },
  })
}

/** The slice of `@basaltkit/http`'s enricher info the audit enricher reads (no import). */
interface AuditHttpEnricherInfo {
  request: { headers: Record<string, string | string[] | undefined>; ip?: string | undefined }
  context: RequestContext
}

/** Minimal structural `@basaltkit/cli` command context (no dependency on the CLI). */
export interface AuditVerifyCommandContext {
  flags: Record<string, string | boolean>
  io: { log(message: string): void; error(message: string): void }
}

const describeResult = (r: AuditVerifyResult): string => {
  const chain = r.tenantId === undefined ? '(system)' : r.tenantId
  const unchained = r.unchained > 0 ? `, ${r.unchained} unchained legacy row(s)` : ''
  return r.ok
    ? `${chain}: ok — ${r.checked} entr${r.checked === 1 ? 'y' : 'ies'} verified${r.head ? `, head #${r.head.seq} ${r.head.hash}` : ''}${unchained}`
    : `${chain}: BROKEN at seq ${String(r.firstBrokenAt)} (${String(r.reason)})${r.entryId ? ` entry ${r.entryId}` : ''} — ${r.checked} verified before it${unchained}`
}

/**
 * The `audit:verify` command, as a plain `@basaltkit/cli` command definition.
 * `auditPlugin({ integrity: 'hash-chain' })` registers it automatically; call
 * this yourself to register it elsewhere (e.g. `cliPlugin([createAuditVerifyCommand(...)])`).
 *
 * `basalt audit:verify [--tenant=<id>] [--from=<seq>] [--to=<seq>]` verifies one
 * chain (the system chain without `--tenant`); `--all` verifies every chain.
 * Exits 1 when any chain is broken.
 */
export function createAuditVerifyCommand(getAudit: () => Audit) {
  const int = (value: string | boolean, name: string): number => {
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`--${name} must be a positive integer`)
    return n
  }
  return {
    name: 'audit:verify',
    description: 'Verify the audit trail hash chain (--tenant=<id> | --all, --from/--to=<seq>)',
    async handle({ flags, io }: AuditVerifyCommandContext): Promise<number> {
      const audit = getAudit()
      const results =
        flags['all'] === true
          ? (await audit.verifyAll()).chains
          : [
              await audit.verify({
                ...(typeof flags['tenant'] === 'string' ? { tenantId: flags['tenant'] } : {}),
                ...(flags['from'] !== undefined ? { from: int(flags['from'], 'from') } : {}),
                ...(flags['to'] !== undefined ? { to: int(flags['to'], 'to') } : {}),
              }),
            ]
      for (const r of results) (r.ok ? io.log : io.error)(describeResult(r))
      return results.every((r) => r.ok) ? 0 : 1
    },
  }
}
