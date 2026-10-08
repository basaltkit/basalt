import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { createToken, definePlugin, ensureMetadata, tryCtx, type RequestContext } from '@basaltkit/core'
import { EVENTS } from '@basaltkit/events'
import {
  AUDIT_CHAIN_GENESIS,
  AUDIT_ERASED,
  AUDIT_REDACTED_EVENT,
  AUDIT_SYSTEM_CHAIN,
  AuditChainConflictError,
  AuditEntryNotFoundError,
  AuditRedactionConflictError,
  AuditRedactionRefusedError,
  assertAuditKeyId,
  assertIntegrityKey,
  auditChainKey,
  auditKeyId,
  auditRedactionState,
  auditStableJson,
  checkAuditHash,
  type AuditIntegrityKey,
  type AuditSigningKey,
  computeAuditHashV2,
  computeAuditHashV3,
  parseAuditChainKey,
  parseAuditHash,
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
  /**
   * Self-describing hash over `prevHash` + the canonical entry:
   * `v2:sha256:<hex>` or `v2:hmac-sha256:<keyId>:<hex>` (see `computeAuditHashV2`),
   * or a bare 64-hex legacy (v1) hash on entries written before key ids existed.
   * A redacted entry keeps its original hash (it still carries the chain links);
   * its content is then authenticated by its `audit:redacted` attestation.
   */
  readonly hash?: string | undefined
  /**
   * v3 entries only (`integrity.erasable`): 256 random bits (hex) mixed into
   * the hash, cleared when the entry is redacted — after which nobody can
   * recompute the hash to confirm a guess of an erased value. Stores must
   * round-trip it (column `nonce`).
   */
  readonly nonce?: string | undefined
  /**
   * Present once personal data was erased from the entry with
   * {@link Audit.redact}. Stores must round-trip it (columns `redaction` and
   * `redactedBy`): a store that drops it turns every redacted entry into a
   * `hash-mismatch`.
   */
  readonly redaction?: AuditRedactionMarker | undefined
}

/** What was erased from an entry, and which attestation vouches for it. */
export interface AuditRedactionMarker {
  /** Id of the latest `audit:redacted` entry attesting this state (column `redactedBy`). */
  readonly attestationId: string
  /** Payload paths erased so far (the `fieldPolicies` grammar), sorted, or `'all'`. */
  readonly payload: readonly string[] | 'all'
  /** Whether `ip` was erased. */
  readonly ip: boolean
  /** Whether `userAgent` was erased. */
  readonly userAgent: boolean
}

/**
 * Who could still confirm a guess of an erased value from the entry's hash:
 * `'none'` (unchained entry), `'keyed'` (an HMAC chain: only the holder of the
 * integrity key), `'public'` (a plain SHA-256 chain: anyone who reads the row).
 */
export type AuditRedactionResidual = 'none' | 'keyed' | 'public'

/** What {@link Audit.redact} erases from one entry. */
export interface AuditRedactRequest {
  /**
   * Payload paths to erase, in the `fieldPolicies` grammar (`customer.email`,
   * `items[].name`; at most 64), or `'all'` for the whole payload. Every value a
   * path reaches becomes {@link AUDIT_ERASED}; paths absent from the payload are
   * skipped.
   */
  payload?: readonly string[] | 'all'
  /** Erase the client IP. */
  ip?: boolean
  /** Erase the user-agent. */
  userAgent?: boolean
  /**
   * Opaque, NON-personal reference recorded in the attestation — a DSR or
   * ticket id (1–128 printable characters). Never a free-text reason: that
   * would write personal data back into the trail.
   */
  reasonRef?: string
  /**
   * The highest {@link AuditRedactionResidual} accepted. Default `'keyed'`:
   * erasing from an unkeyed (plain SHA-256) chain, whose hash anyone can use to
   * confirm a guess, must be acknowledged with `'public'`.
   */
  residual?: AuditRedactionResidual
  /** The tenant, when there is no tenant in context (like `trail({ tenantId })`). Ignored inside a tenant context. */
  tenantId?: string
  /** The eraser, when there is no user in context. Must equal the context user when there is one. */
  actorId?: string
}

/** Outcome of {@link Audit.redact}. */
export interface AuditRedactResult {
  /** The entry as stored now. */
  entry: AuditEntry
  /** The `audit:redacted` entry appended — `undefined` when nothing changed. */
  attestation: AuditEntry | undefined
  /** `false` when every requested field was already erased or absent (nothing written). */
  changed: boolean
  residual: AuditRedactionResidual
}

/** One atomic redaction, as {@link AuditStore.redact} receives it. */
export interface AuditRedactionWrite {
  id: string
  /** Optimistic check: the row must still have this `hash` and this `redactedBy` (`undefined` = NULL). */
  expect: { hash: string | undefined; redactedBy: string | undefined }
  payload: unknown
  ip: string | undefined
  userAgent: string | undefined
  redaction: AuditRedactionMarker
  /** Appended in the same transaction, with `append()`'s `(chain, seq)` conflict semantics. */
  attestation: AuditEntry
}

export interface AuditQuery {
  /** Wildcard pattern over the event name (e.g. 'auth:**'). */
  event?: string
  tenantId?: string
  actorId?: string
  since?: number
  limit?: number
  /**
   * Only rows that belong to their tenant's hash chain (they carry a `seq` under
   * the chain their `tenantId` maps to). Excludes rows written without the chain —
   * legacy rows, and rows inserted into the database behind `Audit`'s back. It
   * does not prove the returned rows are intact: that is {@link Audit.verify}.
   */
  chainedOnly?: boolean
}

/**
 * Throws unless every filter of an {@link AuditQuery} has its declared type.
 *
 * Handlers routinely forward a parsed query string, and a parser such as `qs`
 * turns `?tenantId[not]=x` into `{ not: 'x' }` — which an ORM driver would read
 * as an operator ("every tenant but x"). {@link Audit} validates every read, and
 * the bundled drivers validate again so a store called directly is equally safe.
 */
export function assertAuditQuery(query: unknown): asserts query is AuditQuery {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    throw new TypeError('AuditQuery must be an object')
  }
  const q = query as Record<string, unknown>
  for (const field of ['event', 'tenantId', 'actorId'] as const) {
    if (q[field] !== undefined && typeof q[field] !== 'string') {
      throw new TypeError(`AuditQuery.${field} must be a string`)
    }
  }
  if (q['since'] !== undefined && (typeof q['since'] !== 'number' || !Number.isFinite(q['since']))) {
    throw new TypeError('AuditQuery.since must be a finite number (epoch milliseconds)')
  }
  if (q['chainedOnly'] !== undefined && typeof q['chainedOnly'] !== 'boolean') {
    throw new TypeError('AuditQuery.chainedOnly must be a boolean')
  }
  assertAuditLimit(q['limit'])
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

/** Rows outside a chain to read for verification — see {@link AuditStore.readUnchained}. */
export interface AuditUnchainedRange {
  /** Rows with `at >= since` (a row that claims a chain position is returned whatever its `at`). */
  since: number
  limit: number
}

/** A window of a hash chain, inclusive on both ends, read in ascending `seq` order. */
export interface AuditChainRange {
  fromSeq: number
  toSeq?: number | undefined
  limit: number
}

/**
 * Append-only by contract: no update, no delete — except {@link AuditStore.redact},
 * the one sanctioned, attested in-place change.
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
  /**
   * Every tenant that has at least one row, chained or not (`undefined` = rows
   * without a tenant). Optional: {@link Audit.verifyAll} uses it to reach
   * tenants whose rows were all written outside a chain — without it, it falls
   * back to scanning `query({})`, which reads the whole trail. Implement it with
   * a `SELECT DISTINCT tenant_id` in a durable store.
   */
  auditTenants?(): Promise<Array<string | undefined>>
  /**
   * Rows attributed to the tenant (`undefined` = no tenant) that are NOT part of
   * its chain — no `seq`, or a `chain` other than `auditChainKey(tenantId)` —
   * with `at >= range.since`, plus every such row that carries a `seq` or a
   * chain name whatever its `at` (a legacy row has neither). Oldest first, at
   * most `range.limit`. Optional: without it {@link Audit.verify} falls back to
   * scanning `query()`.
   */
  readUnchained?(tenantId: string | undefined, range: AuditUnchainedRange): Promise<AuditEntry[]>
  /**
   * One entry by id, in any chain. Required by {@link Audit.redact}, and by
   * `verify()` as soon as a redacted entry exists (it reads the attestation).
   */
  get?(id: string): Promise<AuditEntry | undefined>
  /**
   * The ONLY sanctioned in-place change. Atomically: sets `payload`, `ip`,
   * `userAgent` and `redaction` (persist `redaction.attestationId` as
   * `redactedBy`) and clears `nonce` — only if the row's `hash` and
   * `redactedBy` still equal `write.expect`, else throws
   * {@link AuditRedactionConflictError} — and appends `write.attestation` with
   * `append()`'s semantics (a taken `(chain, seq)` throws
   * {@link AuditChainConflictError}). On any error, nothing is written.
   */
  redact?(write: AuditRedactionWrite): Promise<void>
}

/**
 * Deep-frozen copy of a payload: history handed out by `record()` / `trail()`
 * must not be editable through a nested reference (that would silently change
 * what the trail says and break the chain). `structuredClone` first so the
 * caller's own object is never frozen; a payload it cannot clone (a function
 * inside) falls back to the JSON form a durable store would persist anyway.
 */
function frozenPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload
  return deepFreeze(clonePayload(payload))
}

/** A deep copy of an object payload: `structuredClone`, or its JSON form when it holds something uncloneable. */
function clonePayload(payload: object): unknown {
  try {
    return structuredClone(payload)
  } catch {
    const json = JSON.stringify(payload)
    return json === undefined ? undefined : (JSON.parse(json) as unknown)
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key])
  return value
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
    this.entries.push(Object.freeze({ ...entry, payload: frozenPayload(entry.payload) }))
  }

  async get(id: string): Promise<AuditEntry | undefined> {
    return this.entries.find((e) => e.id === id)
  }

  async redact(write: AuditRedactionWrite): Promise<void> {
    // Every check before the first change: the method is synchronous after
    // this point, so in memory the update and the append are one atomic step.
    const index = this.entries.findIndex((e) => e.id === write.id)
    const current = index < 0 ? undefined : this.entries[index]!
    if (current === undefined || current.hash !== write.expect.hash || current.redaction?.attestationId !== write.expect.redactedBy) {
      throw new AuditRedactionConflictError(write.id)
    }
    const attestation = write.attestation
    const slot = attestation.seq === undefined ? undefined : `${auditChainKey(attestation.tenantId)}#${attestation.seq}`
    if (slot !== undefined && this.chainSlots.has(slot)) throw new AuditChainConflictError(attestation.tenantId, attestation.seq)
    const { ip: _ip, userAgent: _userAgent, nonce: _nonce, redaction: _redaction, ...rest } = current
    this.entries[index] = Object.freeze({
      ...rest,
      payload: frozenPayload(write.payload),
      ...(write.ip !== undefined ? { ip: write.ip } : {}),
      ...(write.userAgent !== undefined ? { userAgent: write.userAgent } : {}),
      redaction: deepFreeze(structuredClone(write.redaction)),
    })
    if (slot !== undefined) this.chainSlots.add(slot)
    this.entries.push(Object.freeze({ ...attestation, payload: frozenPayload(attestation.payload) }))
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

  async auditTenants(): Promise<Array<string | undefined>> {
    return [...new Set(this.entries.map((e) => e.tenantId))]
  }

  async readUnchained(tenantId: string | undefined, range: AuditUnchainedRange): Promise<AuditEntry[]> {
    assertAuditLimit(range.limit)
    // In memory a row's chain IS its tenant's: every row with a `seq` is read by
    // readChain(), so only seq-less rows are outside it.
    return this.entries
      .filter((e) => e.seq === undefined && e.tenantId === tenantId && e.at >= range.since)
      .sort((a, b) => a.at - b.at)
      .slice(0, range.limit)
  }

  async query(query: AuditQuery): Promise<AuditEntry[]> {
    assertAuditQuery(query)
    let results = this.entries.filter(
      (entry) =>
        (query.chainedOnly !== true || entry.seq !== undefined) &&
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
/** Stand-in for a masked value. */
const REDACTED = '[redacted]'

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

/**
 * Substrings that make a key sensitive wherever they appear in its normalized
 * form (lower-cased, separators removed): specific enough not to hit ordinary
 * words — `pass` is NOT here (it would hit `compass`, `bypass`), `session` is
 * handled separately (it would hit `sessionCount`).
 */
const SENSITIVE_FRAGMENT =
  /password|passwd|passphrase|passcode|passport|secret|token|credential|authorization|cookie|apikey|privatekey|accesskey|secretkey|signingkey|encryptionkey|connectionstring|databaseurl/
/** Whole words (a key segment after camelCase / `_` / `-` / `.` splitting) that make a key sensitive. */
const SENSITIVE_WORDS = new Set(['pwd', 'pass', 'jwt', 'auth', 'otp', 'totp', 'mfa', 'dsn', 'bearer', 'sid'])
/** `session`, `userSession`, `sessionId`, `session_key` — but not `sessionCount`. */
const SESSION_KEY = /session(s|id|key|cookie)?$/
/**
 * Keys that walk into the prototype machinery when assigned with `obj[k] = v`.
 * They are kept as OWN properties with a masked value, so a mass-assignment
 * attempt stays visible in the trail instead of vanishing (or turning into the
 * copy's prototype).
 */
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Splits `privateKey`, `private_key`, `X-Private-Key` into lower-case words. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0)
}

/**
 * Whether a payload key names a secret. Segment-aware rather than a bare
 * substring test: `pwd`, `privateKey`, `jwt`, `auth`, `accessKey` are masked;
 * `compass`, `bypass`, `sessionCount`, `author` are not.
 */
export function isSensitiveKey(key: string): boolean {
  if (key.length > 256) return true // absurd keys are not worth the risk of a miss
  const words = keyWords(key)
  const joined = words.join('')
  return SENSITIVE_FRAGMENT.test(joined) || SESSION_KEY.test(joined) || words.some((w) => SENSITIVE_WORDS.has(w))
}

/** Sets `out[key] = value` as an own data property, even for `__proto__`. */
function setOwn(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
}

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
    setOwn(out, k, PROTO_KEYS.has(k) || isSensitiveKey(k) ? REDACTED : redactSensitive(v, depth + 1))
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
/**
 * A value that looks like a phone number in international form: a leading `+`,
 * then digits with optional spaces, dots, dashes or parentheses (`+351 912 345 678`,
 * `+1 (555) 123-4567`, `+15551234567`). The `+` is required — a bare digit
 * string is as likely an order id, an amount or a date — and the digit count
 * must fit E.164 (8 to 15). National formats are only caught under a PII key.
 */
const PHONE_VALUE = /^\+\(?\d[\d\s().-]*$/
const MAX_PHONE_LENGTH = 32

function isPhoneShaped(value: string): boolean {
  if (value.length > MAX_PHONE_LENGTH || !PHONE_VALUE.test(value)) return false
  const digits = value.replace(/\D/g, '').length
  return digits >= 8 && digits <= 15
}

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
  return processKey()
}
/** The random per-process pseudonymization key (no warning: callers warn in their own words). */
function processKey(): Buffer {
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
    return (value.length <= 320 && EMAIL_VALUE.test(value)) || isPhoneShaped(value) ? pseudonymize(value, options.key) : value
  if (typeof value !== 'object') return value
  if (depth > MAX_REDACT_DEPTH) return TRUNCATED
  if (Array.isArray(value)) return value.map((v) => redactSensitiveAndPii(v, depth + 1, options))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (PROTO_KEYS.has(k) || isSensitiveKey(k)) setOwn(out, k, REDACTED)
    else if (PII_KEY.test(k) || IP_KEY.test(k)) setOwn(out, k, pseudonymizeAll(v, depth + 1, options))
    else setOwn(out, k, redactSensitiveAndPii(v, depth + 1, options))
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
    setOwn(out, k, PROTO_KEYS.has(k) || isSensitiveKey(k) ? REDACTED : pseudonymizeAll(v, depth + 1, options))
  }
  return out
}

/**
 * Payload scrubber that also pseudonymizes obvious PII (PII F3), keyed with
 * HMAC-SHA256. Opt-in — pass it to `auditPlugin({ redact: createPiiMinimizingRedactor({ key }) })`.
 * The key is validated up front (>= 128 bits); without one, pseudonyms use a
 * random per-process key and a warning is logged.
 *
 * It works on key names and value shapes, so it cannot know that `notes` or
 * `fullName` of one particular event is personal data: declare that per event
 * with `fieldPolicies` (see {@link AuditFieldPolicy}), which runs before it.
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

/**
 * What to do with the personal data of one event's payload, by dotted path
 * (`customer.email`, `items.name`). Arrays are walked transparently: `items.name`
 * reaches the `name` of every element of `items`, and a segment may be written
 * `items[].name` to say so. Paths absent from a payload are ignored.
 *
 * - `omit`: the field is removed before the entry is stored or hashed.
 * - `pseudonymize`: every scalar under the field is replaced by its keyed
 *   HMAC pseudonym (`pii_<hex>`, see {@link pseudonymize}), so entries stay
 *   correlatable without storing the value.
 *
 * A path listed in both is omitted.
 */
export interface AuditFieldPolicy {
  omit?: string[]
  pseudonymize?: string[]
}

/** {@link AuditFieldPolicy} per event or hook name (an exact name, not a pattern). */
export type AuditFieldPolicies = Record<string, AuditFieldPolicy>

/** Deepest path a field policy may name. */
const MAX_FIELD_POLICY_DEPTH = 8
/** Longest path a field policy may name. */
const MAX_FIELD_POLICY_PATH = 256
/** How many nested levels a field policy walks before dropping the branch. */
const MAX_FIELD_POLICY_WALK = 32

interface CompiledFieldPolicy {
  omit: string[][]
  pseudonymize: string[][]
}

let warnedUnkeyedFieldPolicy = false

/**
 * Validates `fieldPolicies` once, at configuration time, and splits each path
 * into its segments. A typo (`omitt`), an empty or prototype segment, or an
 * absurdly deep path is a `TypeError` here rather than a silent no-op later.
 */
function compileFieldPolicies(
  policies: AuditFieldPolicies | undefined,
  key: PseudonymizationKey | undefined,
): { policies: ReadonlyMap<string, CompiledFieldPolicy>; key: PseudonymizationKey | undefined } {
  if (key !== undefined) assertPseudonymKey(key)
  const compiled = new Map<string, CompiledFieldPolicy>()
  if (policies === undefined) return { policies: compiled, key }
  if (policies === null || typeof policies !== 'object' || Array.isArray(policies)) {
    throw new TypeError('Audit `fieldPolicies` must be an object keyed by event name')
  }
  let pseudonymizes = false
  for (const [event, policy] of Object.entries(policies)) {
    if (event.length === 0) throw new TypeError('Audit `fieldPolicies` keys must be non-empty event names')
    if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
      throw new TypeError(`Audit fieldPolicies["${event}"] must be an object { omit?, pseudonymize? }`)
    }
    for (const field of Object.keys(policy)) {
      if (field !== 'omit' && field !== 'pseudonymize') {
        throw new TypeError(`Audit fieldPolicies["${event}"] has an unknown option "${field}" (expected omit, pseudonymize)`)
      }
    }
    const paths = (field: 'omit' | 'pseudonymize'): string[][] => {
      const list: unknown = policy[field]
      if (list === undefined) return []
      if (!Array.isArray(list)) throw new TypeError(`Audit fieldPolicies["${event}"].${field} must be an array of paths`)
      return list.map((path: unknown) => fieldPath(`Audit fieldPolicies["${event}"].${field}`, path))
    }
    const entry = { omit: paths('omit'), pseudonymize: paths('pseudonymize') }
    if (entry.pseudonymize.length > 0) pseudonymizes = true
    compiled.set(event, entry)
  }
  if (pseudonymizes && key === undefined && !warnedUnkeyedFieldPolicy) {
    warnedUnkeyedFieldPolicy = true
    console.warn(
      '[basalt:audit] fieldPolicies pseudonymize without `fieldPolicyKey`: using a random per-process key, so pseudonyms ' +
        'will not correlate across restarts. Pass `fieldPolicyKey` (>= 128 bits; the same key as createPiiMinimizingRedactor ' +
        'gives the same pseudonyms).',
    )
  }
  return { policies: compiled, key }
}

/**
 * Validates one path of the field grammar (shared by `fieldPolicies` and
 * `Audit.redact`) and splits it into segments; `where` prefixes the error.
 */
function fieldPath(where: string, path: unknown): string[] {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_FIELD_POLICY_PATH) {
    throw new TypeError(`${where}: each path must be a non-empty string of at most ${MAX_FIELD_POLICY_PATH} characters`)
  }
  const segments = path.split('.').map((segment) => (segment.endsWith('[]') ? segment.slice(0, -2) : segment))
  if (segments.length > MAX_FIELD_POLICY_DEPTH) {
    throw new TypeError(`${where}: path "${path}" is deeper than ${MAX_FIELD_POLICY_DEPTH} segments`)
  }
  for (const segment of segments) {
    if (segment.length === 0) throw new TypeError(`${where}: path "${path}" has an empty segment`)
    if (PROTO_KEYS.has(segment)) throw new TypeError(`${where}: path "${path}" names a prototype key`)
  }
  return segments
}

/**
 * Applies one event's policy to a deep copy of the payload (the caller's object
 * is never touched): omitted fields are deleted, pseudonymized ones replaced.
 */
function applyFieldPolicy(payload: unknown, policy: CompiledFieldPolicy, key: PseudonymizationKey): unknown {
  if (payload === null || typeof payload !== 'object') return payload
  const copy = clonePayload(payload)
  for (const path of policy.omit) {
    walkFieldPath(copy, path, 0, 0, (parent, name) => {
      delete parent[name]
    })
  }
  for (const path of policy.pseudonymize) {
    walkFieldPath(copy, path, 0, 0, (parent, name) => {
      parent[name] = pseudonymizeAll(parent[name], 0, { key })
    })
  }
  return copy
}

/** Calls `fn(parent, lastSegment)` for every own field the path reaches, through arrays. */
function walkFieldPath(
  node: unknown,
  path: readonly string[],
  index: number,
  walked: number,
  fn: (parent: Record<string, unknown>, name: string) => void,
): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    // Object levels are bounded by the path; only nested arrays can go deeper.
    // Past the bound the branch is dropped (fail closed), as the redactors do.
    for (let i = 0; i < node.length; i++) {
      const element: unknown = node[i]
      if (element !== null && typeof element === 'object' && walked >= MAX_FIELD_POLICY_WALK) node[i] = TRUNCATED
      else walkFieldPath(element, path, index, walked + 1, fn)
    }
    return
  }
  const record = node as Record<string, unknown>
  const name = path[index]!
  if (!Object.hasOwn(record, name)) return
  if (index === path.length - 1) fn(record, name)
  else walkFieldPath(record[name], path, index + 1, walked + 1, fn)
}

/** Client information of the originating request. */
export interface AuditRequestInfo {
  ip?: string | undefined
  userAgent?: string | undefined
}

/** Resolves the request fields to record, from the active context (if any). */
export type AuditRequestContextResolver = (context: RequestContext | undefined) => AuditRequestInfo | undefined

/**
 * The keyed form of `integrity: 'hash-chain'`. Every new entry is an
 * HMAC-SHA256 under `key`, and its hash records `keyId`
 * (`v2:hmac-sha256:<keyId>:<hex>`), so rotating the key does not invalidate
 * what the old one signed: move the old key to `verifyKeys` and verification
 * picks each entry's key by its id.
 *
 * ```ts
 * integrity: {
 *   mode: 'hash-chain',
 *   key: process.env.AUDIT_CHAIN_KEY!, keyId: '2026-09',
 *   verifyKeys: [{ id: '2026-01', key: process.env.AUDIT_CHAIN_KEY_2026_01! }],
 * }
 * ```
 */
export interface AuditHashChainIntegrity {
  mode: 'hash-chain'
  /** Signs new entries (HMAC-SHA256, >= 128 bits). Omit for a plain SHA-256 chain. */
  key?: AuditIntegrityKey
  /**
   * The id recorded with every entry `key` signs ({@link AUDIT_KEY_ID_PATTERN}).
   * Default: `auditKeyId(key)`, a fingerprint derived from the key — the same on
   * every replica. Name it yourself to make rotations readable.
   */
  keyId?: string
  /**
   * Retired keys, for verification only — never used to sign. A bare key gets
   * its default id (`auditKeyId(key)`), which is the id it recorded if it was
   * used without an explicit `keyId`. Legacy (v1) entries, which record no id,
   * are accepted under any key held here or as `key`. Requires `key`.
   */
  verifyKeys?: Array<AuditIntegrityKey | AuditSigningKey>
  /**
   * Write v3 entries: each carries a random `nonce` inside its hash, which
   * {@link Audit.redact} destroys — so after an erasure the stored hash no
   * longer lets anyone (the key holder included) confirm a guess of the erased
   * value. Needs a store with `get()` that persists `nonce` (checked on the
   * first write). Off by default: entries stay v2, byte for byte. Upgrade every
   * verifier before turning it on — an older `@basaltkit/audit` reports v3
   * entries as `hash-mismatch`.
   */
  erasable?: boolean
}

/** `'hash-chain'` (SHA-256) or {@link AuditHashChainIntegrity} (HMAC-SHA256 under a >=128-bit secret). */
export type AuditIntegrity = 'none' | 'hash-chain' | AuditHashChainIntegrity

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
  /**
   * Per-event personal-data policy ({@link AuditFieldPolicy}), keyed by the
   * exact event or hook name. Applied to `record()`, hooks and events BEFORE the
   * redactor and before hashing, so an omitted field never reaches the store or
   * the chain. Use it for personal data: it is the cheapest erasure, the value
   * is never stored. Erasing a stored value later is possible with
   * {@link Audit.redact}, which keeps the chain verifiable through an attested
   * `audit:redacted` entry — but the hash of an older entry can still confirm a
   * guess of the erased value to whoever can compute it (see `residual`).
   */
  fieldPolicies?: AuditFieldPolicies
  /**
   * Keys the `pseudonymize` fields of {@link fieldPolicies} (>= 128 bits). The
   * same key as `createPiiMinimizingRedactor({ key })` yields the same
   * pseudonyms. Without it a random per-process key is used (warned once).
   */
  fieldPolicyKey?: PseudonymizationKey
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
  /**
   * A head recorded earlier OUTSIDE the database (see `head` in the result). The
   * chain must still contain that entry with that hash: a chain truncated below
   * it fails with `'truncated'`, a different hash at that `seq` with
   * `'head-mismatch'`. Without an anchor, deleting the tail leaves no gap.
   */
  expectedHead?: AuditChainHead
  /**
   * Rows outside the chain with `at <= legacyUntil` are legacy (written before
   * integrity was enabled) and only counted in `unchained`; later ones fail the
   * verification (`'unchained-entry'`). Default: the `at` of the chain's first
   * entry (and, with no chain yet, every row is legacy). Pass `0` for a trail
   * that was chained from the start: then no row outside the chain is accepted.
   */
  legacyUntil?: number
}

export type AuditVerifyFailure =
  | 'hash-mismatch'
  | 'prev-hash-mismatch'
  | 'sequence-gap'
  | 'sequence-duplicate'
  | 'missing-predecessor'
  /** A row of the tenant sits outside its chain although it was written after the chain began. */
  | 'unchained-entry'
  /** `expectedHead` is no longer in the chain: the tail was deleted. */
  | 'truncated'
  /** The entry at `expectedHead.seq` has a different hash than the anchor. */
  | 'head-mismatch'
  /** `verifyAll()`: a chain name the store lists but no tenant chain maps back to (a forged `chain` value). */
  | 'unknown-chain'
  /**
   * The entry was signed under a key id this `Audit` does not hold (add the
   * retired key to `verifyKeys`), or under a key while this `Audit` has none.
   */
  | 'unknown-key'
  /**
   * A redacted entry whose `audit:redacted` attestation is missing, does not
   * match its current state, or does not verify — or a store without `get()`
   * holding a redacted entry (see `detail`).
   */
  | 'redaction-mismatch'

export interface AuditVerifyResult {
  ok: boolean
  /** The chain verified (`undefined` = system chain). */
  tenantId: string | undefined
  /** Chained entries that verified before the first failure (all of them when `ok`). */
  checked: number
  /** Of `checked`, the redacted entries — verified through their `audit:redacted` attestation. */
  redacted: number
  /**
   * Rows of this tenant written without a chain. Legacy ones (see
   * `legacyUntil`) are not verifiable but not broken; the others are listed in
   * `unverified` and fail the verification.
   */
  unchained: number
  /**
   * Ids of rows attributed to this tenant that are outside its chain and are NOT
   * legacy — written after the chain began (or claiming a chain position they do
   * not have). `trail()` serves them like any other row, so their presence makes
   * the result `ok: false`. At most 100 are listed.
   */
  unverified: string[]
  /** `seq` of the first entry that failed. */
  firstBrokenAt?: number
  /** Id of the offending row, when there is one. */
  entryId?: string
  reason?: AuditVerifyFailure
  /** Extra explanation of `reason`, when there is one worth giving (e.g. a store method that is missing). */
  detail?: string
  /** Last verified entry — record it outside the database to detect later truncation of the tail. */
  head?: AuditChainHead
}

export interface AuditVerifyAllOptions {
  /**
   * Heads recorded earlier outside the database, keyed by `auditChainKey(tenantId)`
   * (`'@system'`, `'t:<id>'`). Each named chain is verified against its anchor —
   * even one the store no longer lists, so a chain deleted wholesale is reported
   * as `'truncated'` instead of silently disappearing.
   */
  expectedHeads?: Record<string, AuditChainHead>
  /**
   * Applied to every chain — see {@link AuditVerifyOptions.legacyUntil}. A
   * tenant that has rows but no chain at all defaults to the moment integrity
   * began for the whole store (the earliest first entry of any chain): once
   * `Audit` chains, it never writes an unchained row for any tenant again.
   */
  legacyUntil?: number
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
/** Unverified row ids reported by `verify()`. */
const MAX_UNVERIFIED = 100
/** Largest timestamp a `Date` can hold (ECMAScript time value bound). */
const MAX_TIMESTAMP = 8.64e15

/** Longest `actorId` / `tenantId` accepted in a {@link AuditRecordScope}. */
const MAX_SCOPE_ID = 256

/**
 * Explicit attribution of a manual entry — see {@link Audit.record}. Narrowing
 * only: it may restate the context's tenant/user, never replace them.
 */
export interface AuditRecordScope {
  /** Tenant whose chain the entry joins. Must equal the context tenant when there is one. */
  tenantId?: string
  /** Actor of the entry. Must equal the context user when there is one. */
  actorId?: string
}

/** A non-empty, bounded string without control characters. */
function isScopeId(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SCOPE_ID && !/[\u0000-\u001f\u007f]/.test(value)
}

/**
 * The `actorId` / `tenantId` of a manual entry: the context's, restated or
 * supplied (when the context has none) by `scope`. A scope that differs from
 * the context throws — `record()` must not let code running for tenant A write
 * into tenant B's chain, or attribute an action to someone else.
 */
function resolveRecordScope(
  ctxActorId: string | undefined,
  ctxTenantId: string | undefined,
  scope: AuditRecordScope | undefined,
): { actorId: string | undefined; tenantId: string | undefined } {
  if (scope === undefined) return { actorId: ctxActorId, tenantId: ctxTenantId }
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new TypeError('audit.record: scope must be an object { tenantId?, actorId? }')
  }
  const { tenantId, actorId } = scope
  if (tenantId !== undefined && !isScopeId(tenantId)) {
    throw new TypeError(`audit.record: scope.tenantId must be a non-empty string of at most ${MAX_SCOPE_ID} printable characters`)
  }
  if (actorId !== undefined && !isScopeId(actorId)) {
    throw new TypeError(`audit.record: scope.actorId must be a non-empty string of at most ${MAX_SCOPE_ID} printable characters`)
  }
  if (ctxTenantId !== undefined && tenantId !== undefined && tenantId !== ctxTenantId) {
    throw new TypeError('audit.record: scope.tenantId cannot differ from the request tenant')
  }
  if (ctxActorId !== undefined && actorId !== undefined && actorId !== ctxActorId) {
    throw new TypeError('audit.record: scope.actorId cannot differ from the request user')
  }
  return { actorId: ctxActorId ?? actorId, tenantId: ctxTenantId ?? tenantId }
}

/** Most payload paths one redaction (and one stored marker) may name. */
const MAX_REDACT_PATHS = 64
/** Longest `reasonRef`. */
const MAX_REASON_REF = 128
/** Re-reads after a concurrent redaction of the same entry before giving up. */
const MAX_REDACTION_ROUNDS = 3
const RESIDUAL_RANK: Readonly<Record<AuditRedactionResidual, number>> = { none: 0, keyed: 1, public: 2 }
const REDACT_REQUEST_KEYS = new Set(['payload', 'ip', 'userAgent', 'reasonRef', 'residual', 'tenantId', 'actorId'])

/** An {@link AuditRedactRequest}, validated. */
interface CompiledRedaction {
  payload: { paths: string[]; segments: string[][] } | 'all' | undefined
  ip: boolean
  userAgent: boolean
  reasonRef: string | undefined
  residual: AuditRedactionResidual
  tenantId: string | undefined
  actorId: string | undefined
}

/** Who a redaction may reach: one tenant (`undefined` = rows without a tenant), or every row. */
type RedactionScope = { tenantId: string | undefined } | 'any'

/**
 * Validates a redaction request up front — like `fieldPolicies`, a typo
 * (`payloads`) or a prototype segment is a `TypeError`, never a silent no-op.
 */
function compileRedactRequest(method: string, entryId: unknown, request: unknown): CompiledRedaction {
  if (!isScopeId(entryId)) {
    throw new TypeError(`${method}: entryId must be a non-empty string of at most ${MAX_SCOPE_ID} printable characters`)
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError(`${method}: request must be an object { payload?, ip?, userAgent?, reasonRef?, residual?, tenantId?, actorId? }`)
  }
  const r = request as Record<string, unknown>
  for (const key of Object.keys(r)) {
    if (!REDACT_REQUEST_KEYS.has(key)) {
      throw new TypeError(`${method}: unknown option "${key}" (expected ${[...REDACT_REQUEST_KEYS].join(', ')})`)
    }
  }
  let payload: CompiledRedaction['payload']
  if (r['payload'] === 'all') payload = 'all'
  else if (r['payload'] !== undefined) {
    const list = r['payload']
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_REDACT_PATHS) {
      throw new TypeError(`${method}: request.payload must be 'all' or an array of 1-${MAX_REDACT_PATHS} paths`)
    }
    for (const path of list) fieldPath(`${method}: request.payload`, path)
    const paths = [...new Set(list as string[])].sort()
    payload = { paths, segments: paths.map((path) => fieldPath(`${method}: request.payload`, path)) }
  }
  for (const flag of ['ip', 'userAgent'] as const) {
    if (r[flag] !== undefined && typeof r[flag] !== 'boolean') throw new TypeError(`${method}: request.${flag} must be a boolean`)
  }
  if (payload === undefined && r['ip'] !== true && r['userAgent'] !== true) {
    throw new TypeError(`${method}: nothing to erase — pass payload, ip and/or userAgent`)
  }
  const reasonRef = r['reasonRef']
  if (reasonRef !== undefined && (!isScopeId(reasonRef) || reasonRef.length > MAX_REASON_REF)) {
    throw new TypeError(`${method}: request.reasonRef must be a non-empty string of at most ${MAX_REASON_REF} printable characters`)
  }
  const residual = r['residual'] ?? 'keyed'
  if (residual !== 'none' && residual !== 'keyed' && residual !== 'public') {
    throw new TypeError(`${method}: request.residual must be 'none', 'keyed' or 'public'`)
  }
  for (const id of ['tenantId', 'actorId'] as const) {
    if (r[id] !== undefined && !isScopeId(r[id])) {
      throw new TypeError(`${method}: request.${id} must be a non-empty string of at most ${MAX_SCOPE_ID} printable characters`)
    }
  }
  return {
    payload,
    ip: r['ip'] === true,
    userAgent: r['userAgent'] === true,
    reasonRef: reasonRef as string | undefined,
    residual,
    tenantId: r['tenantId'] as string | undefined,
    actorId: r['actorId'] as string | undefined,
  }
}

/** A payload in the form a durable store returns it (a JSON round-trip), as a fresh, mutable copy. */
function jsonCopy(payload: unknown): unknown {
  if (payload === undefined) return undefined
  const json = JSON.stringify(payload)
  return json === undefined ? null : (JSON.parse(json) as unknown)
}

/** The payload after a redaction: every value a requested path reaches becomes {@link AUDIT_ERASED}. */
function erasePayload(payload: unknown, plan: CompiledRedaction): unknown {
  const copy = jsonCopy(payload)
  if (plan.payload === undefined) return copy
  if (plan.payload === 'all') return AUDIT_ERASED
  for (const segments of plan.payload.segments) {
    walkFieldPath(copy, segments, 0, 0, (parent, name) => {
      parent[name] = AUDIT_ERASED
    })
  }
  return copy
}

/** The cumulative erased set: the previous marker's, plus this request's (`'all'` absorbs every path). */
function mergeErased(previous: AuditRedactionMarker | undefined, plan: CompiledRedaction): Omit<AuditRedactionMarker, 'attestationId'> {
  const payload: readonly string[] | 'all' =
    previous?.payload === 'all' || plan.payload === 'all'
      ? 'all'
      : [...new Set([...(previous?.payload ?? []), ...(plan.payload?.paths ?? [])])].sort()
  return { payload, ip: (previous?.ip ?? false) || plan.ip, userAgent: (previous?.userAgent ?? false) || plan.userAgent }
}

/** Whether a stored marker has the expected shape (it comes from a database column). */
function isRedactionMarker(value: unknown): value is AuditRedactionMarker {
  if (value === null || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return (
    typeof m['attestationId'] === 'string' &&
    typeof m['ip'] === 'boolean' &&
    typeof m['userAgent'] === 'boolean' &&
    (m['payload'] === 'all' ||
      (Array.isArray(m['payload']) && m['payload'].length <= MAX_REDACT_PATHS && m['payload'].every((p) => typeof p === 'string')))
  )
}

/**
 * Whether every field the marker declares erased actually holds the erased
 * value (or is absent). This is what narrows a forged attestation to erasure:
 * it can never vouch for a substituted value.
 */
function erasedFieldsHold(entry: AuditEntry, marker: AuditRedactionMarker): boolean {
  if (marker.ip && entry.ip !== undefined) return false
  if (marker.userAgent && entry.userAgent !== undefined) return false
  if (marker.payload === 'all') return entry.payload === AUDIT_ERASED
  const payload = jsonCopy(entry.payload)
  let holds = true
  for (const path of marker.payload) {
    let segments: string[]
    try {
      segments = fieldPath('redaction marker', path)
    } catch {
      return false
    }
    walkFieldPath(payload, segments, 0, 0, (parent, name) => {
      if (parent[name] !== AUDIT_ERASED) holds = false
    })
  }
  return holds
}

const defaultRequestContext: AuditRequestContextResolver = (context) => context?.client

const clip = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined

type ChainStore = Required<Pick<AuditStore, 'chainHead' | 'readChain' | 'countUnchained' | 'chainTenants'>> & AuditStore

export class Audit {
  private readonly chainEnabled: boolean
  /** Write v3 (nonce) entries — `integrity.erasable`. */
  private readonly erasable: boolean
  /** `undefined` until the first v3 write is read back; then whether the store kept its nonce. */
  private nonceRoundTrip: boolean | undefined
  /** Signs new entries; `undefined` = plain SHA-256. */
  private readonly signer: AuditSigningKey | undefined
  /** Every key verification may use, by id (the signer's included). Empty = unkeyed chain. */
  private readonly verifyKeys: ReadonlyMap<string, AuditIntegrityKey>
  private readonly requestContext: AuditRequestContextResolver | undefined
  private readonly fieldPolicies: ReadonlyMap<string, CompiledFieldPolicy>
  private readonly fieldPolicyKey: PseudonymizationKey | undefined
  /** Per-chain in-process mutex: appends to one chain run one at a time. */
  private readonly chainLocks = new Map<string, Promise<void>>()

  constructor(
    private readonly store: AuditStore,
    /** Scrubs each payload before it is stored. Default masks common secret keys. */
    private readonly redactor: AuditRedactor = defaultAuditRedactor,
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
    if (typeof integrity === 'object' && integrity.mode !== 'hash-chain') {
      throw new TypeError(`Unknown audit integrity mode: ${String(integrity.mode)}`)
    }
    const erasable = typeof integrity === 'object' ? integrity.erasable : undefined
    if (erasable !== undefined && typeof erasable !== 'boolean') throw new TypeError('Audit integrity `erasable` must be a boolean')
    this.erasable = erasable === true
    if (this.erasable && typeof store.get !== 'function') {
      throw new TypeError(
        'Audit integrity `erasable` needs a store implementing get() that persists `nonce` ' +
          '(MemoryAuditStore, @basaltkit/audit-sqlite >= 2.1, @basaltkit/audit-prisma >= 2.1 with the `nonce` column).',
      )
    }
    const keys = typeof integrity === 'object' ? keyRing(integrity) : { signer: undefined, verifyKeys: new Map() }
    this.signer = keys.signer
    this.verifyKeys = keys.verifyKeys
    if (this.chainEnabled && !isChainStore(store)) {
      throw new TypeError(
        "Audit integrity 'hash-chain' needs a store implementing chainHead/readChain/countUnchained/chainTenants " +
          '(MemoryAuditStore, @basaltkit/audit-sqlite or @basaltkit/audit-prisma).',
      )
    }
    this.requestContext =
      options.requestContext === true ? defaultRequestContext : options.requestContext || undefined
    const fields = compileFieldPolicies(options.fieldPolicies, options.fieldPolicyKey)
    this.fieldPolicies = fields.policies
    this.fieldPolicyKey = fields.key
  }

  /**
   * Manual entry — for actions no hook covers.
   *
   * `actorId` and `tenantId` come from the active context (`ctx().user.id`,
   * `ctx().tenant.id`). Outside a request — a script, a CLI command, a job that
   * did not restore a context — pass `scope` to attribute the entry explicitly;
   * the entry then joins that tenant's hash chain. `scope` can only NARROW: when
   * the context already has a tenant (or a user), a different `scope.tenantId`
   * (or `scope.actorId`) throws a `TypeError` instead of writing into another
   * tenant's chain. Never forward client input into `scope`.
   *
   * The `audit:` event prefix is reserved for framework events; `'audit:redacted'`
   * (only {@link redact} writes it) throws a `TypeError`.
   */
  async record(event: string, payload?: unknown, scope?: AuditRecordScope): Promise<AuditEntry> {
    if (event === AUDIT_REDACTED_EVENT) {
      throw new TypeError(`audit.record: "${AUDIT_REDACTED_EVENT}" is reserved — only Audit.redact() writes it`)
    }
    return this.append(this.build('manual', event, payload, scope))
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
    // request (a string, a float, a SQL fragment) or an operator object
    // (`?tenantId[not]=x`) must never reach a driver.
    assertAuditQuery(query)
    const ctxTenantId = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    if (ctxTenantId !== undefined) {
      // Force the scope: spread the context tenant LAST so a differing
      // caller-supplied `tenantId` cannot override it.
      return this.read({ ...query, tenantId: ctxTenantId })
    }
    if (query.tenantId !== undefined) {
      // No context, but the caller explicitly pinned a single tenant.
      return this.read(query)
    }
    if (!this.tenancyActive()) {
      // Single-tenant app: no tenant dimension, so an unscoped read is correct
      // and is the everyday call. Nothing to widen — every entry is "ours".
      // A hand-built `new Audit(store)` assumes this; pass `() => true` as
      // `tenancyActive` when building one for a multi-tenant app.
      return this.read(query)
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
    assertAuditQuery(query)
    return this.read(query)
  }

  /**
   * Erases personal data from one stored entry while the trail stays
   * verifiable (RFC 0003). The requested payload paths become
   * {@link AUDIT_ERASED} and the flagged `ip` / `userAgent` are dropped, in
   * place; the entry keeps its original `hash`, so the chain links hold. In the
   * same transaction an `audit:redacted` entry is appended to the entry's own
   * chain, binding its id, `seq`, `hash`, the erased fields and a digest of its
   * new state — `verify()` checks the redacted entry through it.
   *
   * Scoping mirrors {@link trail}: inside a tenant context only that tenant's
   * entries are reachable (another id is {@link AuditEntryNotFoundError});
   * without one, `request.tenantId` pins the tenant; with neither, a
   * multi-tenant app must use {@link systemRedact}. Who may erase is the app's
   * decision — wrap this in an authorized job or command; never forward client
   * input as `entryId` unchecked.
   *
   * Refuses ({@link AuditRedactionRefusedError}, nothing written) an entry that
   * does not verify as it is now, an attestation, a residual above
   * `request.residual`, and a store without `get` / `redact`. Idempotent: a
   * request that changes nothing writes nothing (`changed: false`).
   */
  async redact(entryId: string, request: AuditRedactRequest): Promise<AuditRedactResult> {
    const plan = compileRedactRequest('Audit.redact', entryId, request)
    const ctxTenantId = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    let scope: RedactionScope
    if (ctxTenantId !== undefined) scope = { tenantId: ctxTenantId }
    else if (plan.tenantId !== undefined) scope = { tenantId: plan.tenantId }
    else if (!this.tenancyActive()) scope = 'any'
    else {
      throw new Error(
        'Audit.redact() requires a tenant in context or an explicit tenantId. ' +
          'For a deliberate cross-tenant erasure use Audit.systemRedact().',
      )
    }
    return this.redactEntry(entryId, plan, scope)
  }

  /**
   * SYSTEM-ONLY: {@link redact} across every tenant — `request.tenantId`, when
   * given, still pins one. For trusted data-subject-request tooling only; never
   * call it with, or forward into it, client-controlled input.
   */
  async systemRedact(entryId: string, request: AuditRedactRequest): Promise<AuditRedactResult> {
    const plan = compileRedactRequest('Audit.systemRedact', entryId, request)
    return this.redactEntry(entryId, plan, plan.tenantId !== undefined ? { tenantId: plan.tenantId } : 'any')
  }

  private async redactEntry(entryId: string, plan: CompiledRedaction, scope: RedactionScope): Promise<AuditRedactResult> {
    const store = this.erasureStore()
    const context = tryCtx()
    const ctxActorId = (context?.['user'] as { id?: string } | undefined)?.id
    if (ctxActorId !== undefined && plan.actorId !== undefined && plan.actorId !== ctxActorId) {
      throw new TypeError('Audit.redact: request.actorId cannot differ from the request user')
    }
    const actorId = ctxActorId ?? plan.actorId
    const load = async (): Promise<AuditEntry> => {
      const row = await store.get(entryId)
      if (row === undefined || (scope !== 'any' && row.tenantId !== scope.tenantId)) throw new AuditEntryNotFoundError()
      return row
    }
    // The chain of the attestation is the entry's own — read it once to pick the lock.
    const { tenantId } = await load()
    return this.withChainLock(auditChainKey(tenantId), async () => {
      rounds: for (let round = 1; ; round++) {
        const row = await load()
        if (row.event === AUDIT_REDACTED_EVENT) {
          throw new AuditRedactionRefusedError(
            'unverified',
            `Audit.redact: an ${AUDIT_REDACTED_EVENT} attestation cannot be redacted (it holds no personal data, and it vouches for another entry)`,
          )
        }
        await this.assertRedactable(row)
        const residual = this.residualOf(row)
        if (RESIDUAL_RANK[residual] > RESIDUAL_RANK[plan.residual]) {
          throw new AuditRedactionRefusedError(
            'residual',
            residual === 'public'
              ? "Audit.redact: the entry's hash is a plain SHA-256 — after erasure anyone who reads the row can still confirm a guess of the erased value. Pass residual: 'public' to accept that, or key the chain (integrity.key) for new entries."
              : "Audit.redact: the entry's hash is keyed — after erasure the integrity key holder can still confirm a guess of the erased value. Pass residual: 'keyed' to accept that.",
          )
        }
        const payload = erasePayload(row.payload, plan)
        const ip = plan.ip ? undefined : row.ip
        const userAgent = plan.userAgent ? undefined : row.userAgent
        const changed =
          auditStableJson(jsonCopy(row.payload) ?? null) !== auditStableJson(payload ?? null) || ip !== row.ip || userAgent !== row.userAgent
        if (!changed) return { entry: row, attestation: undefined, changed: false, residual }
        const erased = mergeErased(row.redaction, plan)
        for (let attempt = 1; ; attempt++) {
          const attestationId = randomUUID()
          const redaction: AuditRedactionMarker = deepFreeze({ attestationId, ...erased })
          const { ip: _ip, userAgent: _userAgent, nonce: _nonce, redaction: _redaction, ...header } = row
          const redacted: AuditEntry = Object.freeze({
            ...header,
            payload: frozenPayload(payload),
            ...(ip !== undefined ? { ip } : {}),
            ...(userAgent !== undefined ? { userAgent } : {}),
            redaction,
          })
          const attestation = await this.chainLink({
            id: attestationId,
            source: 'manual',
            event: AUDIT_REDACTED_EVENT,
            // Built here, not by build(): neither fieldPolicies nor the redactor
            // may touch it (a redactor that masks `hash` or `state` would make it
            // unverifiable), and it holds no personal data.
            payload: frozenPayload({
              entryId: row.id,
              seq: row.seq ?? null,
              hash: row.hash ?? null,
              erased: { payload: erased.payload === 'all' ? 'all' : [...erased.payload], ip: erased.ip, userAgent: erased.userAgent },
              state: auditRedactionState(redacted),
              ...(plan.reasonRef !== undefined ? { reasonRef: plan.reasonRef } : {}),
            }),
            actorId,
            // Always the entry's own tenant (its chain) — never the caller's
            // scope: an attestation in another chain would never verify.
            tenantId: row.tenantId,
            requestId: context?.requestId,
            ...this.requestFields(context, AUDIT_REDACTED_EVENT),
            at: Date.now(),
          })
          try {
            await store.redact({
              id: row.id,
              expect: { hash: row.hash, redactedBy: row.redaction?.attestationId },
              payload,
              ip,
              userAgent,
              redaction,
              attestation,
            })
            await this.assertNonceRoundTrip(attestation)
            return { entry: redacted, attestation, changed: true, residual }
          } catch (error) {
            // A concurrent redaction of the same entry won: re-read it and merge
            // into its newer state.
            if (error instanceof AuditRedactionConflictError && round < MAX_REDACTION_ROUNDS) continue rounds
            // Another writer took the attestation's seq: re-link and retry.
            if (!(error instanceof AuditChainConflictError) || attempt >= MAX_CHAIN_ATTEMPTS) throw error
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 4 * attempt))
          }
        }
      }
    })
  }

  /** Refuses to attest an entry that does not verify as it is now (anti-laundering). */
  private async assertRedactable(row: AuditEntry): Promise<void> {
    const chained = row.seq !== undefined || row.hash !== undefined
    if (chained && !this.chainEnabled) {
      throw new AuditRedactionRefusedError(
        'unverified',
        "Audit.redact: the entry is hash-chained but this Audit has integrity 'none' — redact through an Audit configured like the writer, otherwise the attestation is unchained and the entry stops verifying",
      )
    }
    if (row.redaction !== undefined && row.redaction !== null) {
      const problem = await this.redactionProblem(row)
      if (problem !== undefined) {
        throw new AuditRedactionRefusedError('unverified', `Audit.redact: the entry is redacted but does not verify (${problem})`)
      }
      return
    }
    if (chained && checkAuditHash(row, this.verifyKeys) !== 'ok') {
      throw new AuditRedactionRefusedError(
        'unverified',
        'Audit.redact: the entry does not verify as it is (changed outside Audit, or signed under a key this Audit does not hold) — refusing to attest its content',
      )
    }
  }

  /** Who could still confirm a guess of an erased value from the entry's hash. */
  private residualOf(row: AuditEntry): AuditRedactionResidual {
    const parsed = parseAuditHash(row.hash)
    if (parsed === undefined) return 'none'
    if (parsed.version === 1) return this.verifyKeys.size > 0 ? 'keyed' : 'public'
    // v3: redaction destroys the nonce, so nobody can recompute the hash.
    if (parsed.version === 3) return 'none'
    return parsed.alg === 'hmac-sha256' ? 'keyed' : 'public'
  }

  /**
   * Checks a redacted entry against its `audit:redacted` attestation.
   * `undefined` when it holds; otherwise what is wrong.
   */
  private async redactionProblem(entry: AuditEntry): Promise<string | undefined> {
    const marker: unknown = entry.redaction
    if (!isRedactionMarker(marker)) return 'malformed redaction marker'
    if (typeof this.store.get !== 'function') {
      return 'the store has no get() method, so the attestation of a redacted entry cannot be read — implement AuditStore.get()'
    }
    const attestation = await this.store.get(marker.attestationId)
    if (attestation === undefined || attestation.id !== marker.attestationId) return 'attestation not found'
    if (attestation.event !== AUDIT_REDACTED_EVENT || attestation.source !== 'manual') return 'the marker does not point to an attestation'
    if (attestation.tenantId !== entry.tenantId) return 'attestation of another tenant'
    if (entry.seq !== undefined && (attestation.seq === undefined || attestation.seq <= entry.seq)) {
      return 'the attestation is not chained after the entry'
    }
    const claim = attestation.payload as Record<string, unknown> | null
    if (claim === null || typeof claim !== 'object') return 'attestation payload malformed'
    if (claim['entryId'] !== entry.id || claim['seq'] !== (entry.seq ?? null) || claim['hash'] !== (entry.hash ?? null)) {
      return 'the attestation vouches for another entry'
    }
    const declared = { payload: marker.payload, ip: marker.ip, userAgent: marker.userAgent }
    if (auditStableJson(claim['erased'] ?? null) !== auditStableJson(declared)) return 'the erased fields differ from the attestation'
    if (claim['state'] !== auditRedactionState(entry)) return 'the entry changed after it was redacted'
    if (!erasedFieldsHold(entry, marker)) return 'an erased field holds a value'
    if (entry.seq !== undefined || attestation.hash !== undefined) {
      const check = checkAuditHash(attestation, this.verifyKeys)
      if (check !== 'ok') return `the attestation does not verify (${check})`
    }
    return undefined
  }

  /**
   * Checks that the erasure an `audit:redacted` entry attests is still in
   * place: its entry must still be redacted, and its marker must name this
   * attestation or a later one for the same entry. `undefined` when it holds;
   * otherwise what is wrong (an un-erasure, or a rollback to an older state).
   */
  private async attestationProblem(attestation: AuditEntry): Promise<string | undefined> {
    const claim = attestation.payload as Record<string, unknown> | null
    const entryId = claim !== null && typeof claim === 'object' ? claim['entryId'] : undefined
    if (typeof entryId !== 'string') return 'attestation payload malformed'
    if (typeof this.store.get !== 'function') {
      return 'the store has no get() method, so the entry an attestation vouches for cannot be read — implement AuditStore.get()'
    }
    const target = await this.store.get(entryId)
    if (target === undefined) return 'the entry this attestation vouches for is missing'
    const marker: unknown = target.redaction
    if (marker === undefined || marker === null) return 'the entry this attestation vouches for is no longer redacted'
    if (!isRedactionMarker(marker)) return 'the entry this attestation vouches for has a malformed redaction marker'
    if (marker.attestationId === attestation.id) return undefined
    // A newer redaction moved the marker on: it must be a later attestation of
    // the same entry (that one is checked against the entry's current state).
    const newer = await this.store.get(marker.attestationId)
    const newerClaim = newer?.payload as Record<string, unknown> | null | undefined
    if (
      newer === undefined ||
      newer.event !== AUDIT_REDACTED_EVENT ||
      newer.source !== 'manual' ||
      newer.tenantId !== attestation.tenantId ||
      newerClaim === null ||
      typeof newerClaim !== 'object' ||
      newerClaim['entryId'] !== entryId ||
      newer.seq === undefined ||
      attestation.seq === undefined ||
      newer.seq <= attestation.seq
    ) {
      return 'the entry this attestation vouches for was rolled back to an older state'
    }
    return undefined
  }

  private erasureStore(): AuditStore & Required<Pick<AuditStore, 'get' | 'redact'>> {
    const store = this.store
    if (typeof store.get !== 'function' || typeof store.redact !== 'function') {
      throw new AuditRedactionRefusedError(
        'unsupported-store',
        'Audit.redact() needs a store implementing get() and redact() (MemoryAuditStore, @basaltkit/audit-sqlite >= 2.1, @basaltkit/audit-prisma >= 2.1).',
      )
    }
    return store as AuditStore & Required<Pick<AuditStore, 'get' | 'redact'>>
  }

  /** `chainedOnly` is re-applied here: a custom store may not know the filter. */
  private async read(query: AuditQuery): Promise<AuditEntry[]> {
    const rows = await this.store.query(query)
    return query.chainedOnly === true ? rows.filter((e) => e.seq !== undefined) : rows
  }

  /**
   * Verifies one hash chain: recomputes every entry's hash and checks `seq`
   * continuity and the `prevHash` links. Tenant scoping mirrors {@link trail}:
   * inside a tenant context the context tenant is forced; otherwise `tenantId`
   * picks the chain, and omitting it verifies the system chain.
   *
   * Rows of the tenant outside the chain are checked too: those written before
   * the chain began (see `legacyUntil`) are counted as `unchained`; any other is
   * listed in `unverified` and makes the result `ok: false` — `trail()` would
   * serve it as history. Truncating the tail of a chain leaves no gap: pass the
   * `head` recorded elsewhere as `expectedHead` to catch that.
   */
  async verify(options: AuditVerifyOptions = {}): Promise<AuditVerifyResult> {
    if (options.tenantId !== undefined && typeof options.tenantId !== 'string') {
      throw new TypeError('verify: `tenantId` must be a string')
    }
    const ctxTenantId = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    return this.verifyChain(ctxTenantId ?? options.tenantId, options)
  }

  /**
   * SYSTEM-ONLY: verifies every chain in the store (each tenant plus the system
   * chain). Like {@link systemTrail}, for trusted tooling (`basalt audit:verify --all`).
   *
   * Inside a tenant context it is scoped like {@link verify}: only that tenant's
   * chain is verified (and reported), so tenant-facing code cannot enumerate
   * other tenants' ids and heads through it.
   */
  async verifyAll(options: AuditVerifyAllOptions = {}): Promise<AuditVerifyAllResult> {
    const store = this.chainStore()
    const anchors = options.expectedHeads ?? {}
    const legacy = options.legacyUntil !== undefined ? { legacyUntil: options.legacyUntil } : {}
    const anchorOf = (tenantId: string | undefined) => {
      const head = Object.hasOwn(anchors, auditChainKey(tenantId)) ? anchors[auditChainKey(tenantId)] : undefined
      return head !== undefined ? { expectedHead: head } : {}
    }
    const ctxTenantId = (tryCtx()?.['tenant'] as { id?: string } | undefined)?.id
    if (ctxTenantId !== undefined) {
      const chain = await this.verifyChain(ctxTenantId, { ...legacy, ...anchorOf(ctxTenantId) })
      return { ok: chain.ok, chains: [chain] }
    }
    // The system chain first, then tenants in a stable order. A chain named
    // only by an anchor (deleted from the store) is verified too.
    const listed = await store.chainTenants()
    const named = new Set(listed.filter((t): t is string => t !== undefined))
    for (const key of Object.keys(anchors)) {
      if (key !== AUDIT_SYSTEM_CHAIN && !(key.startsWith('t:') && key.length > 2)) {
        throw new TypeError(`verifyAll: expectedHeads key "${key}" is not a chain key ('@system' or 't:<tenantId>')`)
      }
      const tenantId = parseAuditChainKey(key)
      if (tenantId !== undefined) named.add(tenantId)
    }
    // Tenants with rows but no chain: every row of theirs sits outside a chain,
    // so a forged insert under a tenant that never had one would otherwise go
    // unvisited. Their legacy cut-off defaults to when integrity began.
    const chainless = new Set<string>()
    for (const tenantId of await this.tenantsWithRows(store)) {
      if (typeof tenantId === 'string' && tenantId !== '' && !named.has(tenantId)) chainless.add(tenantId)
    }
    const integritySince = chainless.size > 0 && options.legacyUntil === undefined ? await this.integritySince(store, listed) : undefined
    const tenants = [undefined, ...[...new Set([...named, ...chainless])].sort()]
    const chains: AuditVerifyResult[] = []
    for (const tenantId of tenants) {
      const cutoff =
        tenantId !== undefined && chainless.has(tenantId) && integritySince !== undefined ? { legacyUntil: integritySince } : legacy
      const result = await this.verifyChain(tenantId, { ...cutoff, ...anchorOf(tenantId) })
      // The store lists a chain that holds no entry for this tenant: its rows
      // carry a `chain` value no tenant maps to (a forged or corrupted name).
      const ghost =
        result.ok && result.checked === 0 && listed.some((t) => t === tenantId) && tenantId !== undefined
      chains.push(ghost ? { ...result, ok: false, reason: 'unknown-chain' } : result)
    }
    return { ok: chains.every((c) => c.ok), chains }
  }

  private async verifyChain(tenantId: string | undefined, options: AuditVerifyOptions): Promise<AuditVerifyResult> {
    const store = this.chainStore()
    const { from, to, expectedHead, legacyUntil } = options
    const fromSeq = from ?? 1
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 1) throw new TypeError('verify: `from` must be a positive integer')
    if (to !== undefined && (!Number.isSafeInteger(to) || to < fromSeq)) {
      throw new TypeError('verify: `to` must be an integer >= `from`')
    }
    if (expectedHead !== undefined) {
      if (
        expectedHead === null ||
        typeof expectedHead !== 'object' ||
        !Number.isSafeInteger(expectedHead.seq) ||
        expectedHead.seq < 1 ||
        typeof expectedHead.hash !== 'string'
      ) {
        throw new TypeError('verify: `expectedHead` must be { seq: positive integer, hash: string }')
      }
      if (expectedHead.seq < fromSeq || (to !== undefined && expectedHead.seq > to)) {
        throw new TypeError('verify: `expectedHead.seq` must lie within `from`..`to`')
      }
    }
    if (legacyUntil !== undefined && (typeof legacyUntil !== 'number' || Number.isNaN(legacyUntil))) {
      throw new TypeError('verify: `legacyUntil` must be a number (epoch milliseconds)')
    }

    const unchained = await store.countUnchained(tenantId)
    const unverified = await this.unverifiedRows(store, tenantId, legacyUntil)
    let redacted = 0
    const result = (fields: Partial<AuditVerifyResult> & Pick<AuditVerifyResult, 'ok' | 'checked'>): AuditVerifyResult => ({
      tenantId,
      unchained,
      unverified,
      redacted,
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
    /** Id of the last verified entry — the page overlap re-reads it. */
    let lastId: string | undefined
    for (;;) {
      // Every page after the first starts one `seq` early, at the entry just
      // verified. Starting at `expected` would never read a second row that
      // shares the last `seq` of the previous page: a custom store without the
      // `(chain, seq)` unique index could hold a duplicate exactly at the page
      // boundary and verify would stay green.
      const overlap = lastId !== undefined
      const page = await store.readChain(tenantId, {
        fromSeq: overlap ? expected - 1 : expected,
        toSeq: to,
        limit: AUDIT_SCAN_PAGE,
      })
      let skipped = false
      for (const entry of page) {
        const broken = (reason: AuditVerifyFailure, detail?: string) =>
          result({
            ok: false,
            checked,
            firstBrokenAt: expected,
            entryId: entry.id,
            reason,
            ...(detail !== undefined ? { detail } : {}),
            ...(head ? { head } : {}),
          })
        if (overlap && !skipped && entry.id === lastId && entry.seq === expected - 1) {
          skipped = true
          continue
        }
        if (entry.seq !== expected) return broken(entry.seq! < expected ? 'sequence-duplicate' : 'sequence-gap')
        if (entry.prevHash !== prevHash) return broken('prev-hash-mismatch')
        if (entry.tenantId !== tenantId) return broken('hash-mismatch')
        if (entry.redaction !== undefined && entry.redaction !== null) {
          // The stored hash no longer covers the content (it still carries the
          // links): the entry's `audit:redacted` attestation vouches for it.
          const problem = await this.redactionProblem(entry)
          if (problem !== undefined) return broken('redaction-mismatch', problem)
          redacted++
        } else {
          const hashCheck = checkAuditHash(entry, this.verifyKeys)
          if (hashCheck !== 'ok') return broken(hashCheck)
          if (entry.event === AUDIT_REDACTED_EVENT && entry.source === 'manual') {
            // The other direction: an erasure it attests must still be in place.
            // A row restored to its original content (from a backup) matches its
            // original hash again, so only its attestation can reveal it.
            const problem = await this.attestationProblem(entry)
            if (problem !== undefined) return broken('redaction-mismatch', problem)
          }
        }
        if (expectedHead !== undefined && entry.seq === expectedHead.seq && entry.hash !== expectedHead.hash) {
          return broken('head-mismatch')
        }
        prevHash = entry.hash!
        head = { seq: entry.seq, hash: entry.hash! }
        lastId = entry.id
        checked++
        expected++
      }
      if (page.length < AUDIT_SCAN_PAGE) break
    }
    if (expectedHead !== undefined && (head === undefined || head.seq < expectedHead.seq)) {
      return result({ ok: false, checked, firstBrokenAt: (head?.seq ?? fromSeq - 1) + 1, reason: 'truncated', ...(head ? { head } : {}) })
    }
    if (unverified.length > 0) {
      return result({ ok: false, checked, entryId: unverified[0]!, reason: 'unchained-entry', ...(head ? { head } : {}) })
    }
    return result({ ok: true, checked, ...(head ? { head } : {}) })
  }

  /** Every tenant with at least one row — `auditTenants()`, or a scan of `query({})`. */
  private async tenantsWithRows(store: ChainStore): Promise<Array<string | undefined>> {
    if (typeof store.auditTenants === 'function') return store.auditTenants()
    const rows = await store.query({})
    return [...new Set(rows.map((e) => e.tenantId))]
  }

  /**
   * When integrity began for the store: the earliest `at` among the first
   * entries of every chain. `undefined` when there is no chain at all (then
   * every row is legacy, as in {@link verify}).
   */
  private async integritySince(store: ChainStore, chains: Array<string | undefined>): Promise<number | undefined> {
    let since: number | undefined
    for (const tenantId of new Set<string | undefined>([undefined, ...chains])) {
      const [first] = await store.readChain(tenantId, { fromSeq: 1, limit: 1 })
      if (first !== undefined && (since === undefined || first.at < since)) since = first.at
    }
    return since
  }

  /**
   * Ids of the tenant's rows outside its chain that are not legacy. The cut-off
   * is `legacyUntil`, defaulting to the `at` of the chain's first entry: once a
   * chain exists, `Audit` never writes an unchained row for that tenant again,
   * so a later one was inserted behind its back. (A writer who backdates `at`
   * can still pass as legacy — pass `legacyUntil: 0` for a trail chained from
   * the start, and prefer `trail({ chainedOnly: true })` for evidence.)
   */
  private async unverifiedRows(store: ChainStore, tenantId: string | undefined, legacyUntil: number | undefined): Promise<string[]> {
    let cutoff = legacyUntil
    if (cutoff === undefined) {
      const [first] = await store.readChain(tenantId, { fromSeq: 1, limit: 1 })
      cutoff = first === undefined ? Number.POSITIVE_INFINITY : first.at
    }
    // Rows strictly after the cut-off; clamped to a valid Date so every driver can bind it.
    const since = Math.min(Math.max(Math.floor(cutoff) + 1, -MAX_TIMESTAMP), MAX_TIMESTAMP)
    let rows: AuditEntry[]
    if (store.readUnchained !== undefined) {
      rows = await store.readUnchained(tenantId, { since, limit: MAX_UNVERIFIED })
    } else {
      // A custom store without readUnchained: scan the tenant's rows through
      // query(). Rows that claim a chain position are read by readChain(), so
      // only seq-less rows are outside the chain here.
      const candidates = await store.query({ ...(tenantId !== undefined ? { tenantId } : {}), since })
      rows = candidates.filter((e) => e.seq === undefined && e.tenantId === tenantId)
    }
    return rows.slice(0, MAX_UNVERIFIED).map((e) => e.id)
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
        const entry = await this.chainLink(draft)
        try {
          await store.append(entry)
          await this.assertNonceRoundTrip(entry)
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

  /**
   * Links `draft` after the current head of its chain and hashes it — or
   * returns it as is when integrity is off. Callers hold the chain lock.
   */
  private async chainLink(draft: AuditEntry): Promise<AuditEntry> {
    if (!this.chainEnabled) return Object.freeze(draft)
    if (this.erasable && this.nonceRoundTrip === false) throw this.nonceLost()
    const head = await (this.store as ChainStore).chainHead(draft.tenantId)
    const linked = {
      ...draft,
      ...(this.erasable ? { nonce: randomBytes(32).toString('hex') } : {}),
      seq: (head?.seq ?? 0) + 1,
      prevHash: head?.hash ?? AUDIT_CHAIN_GENESIS,
    }
    const hash = this.erasable ? computeAuditHashV3(linked, this.signer) : computeAuditHashV2(linked, this.signer)
    return Object.freeze({ ...linked, hash })
  }

  /**
   * Fails closed when the store does not persist `nonce`: every v3 entry it
   * stored would fail verification forever. Checked once, on the first v3
   * write of this instance (read back with `get()`); a store found dropping
   * the nonce makes every later write throw too.
   */
  private async assertNonceRoundTrip(entry: AuditEntry): Promise<void> {
    if (entry.nonce === undefined || this.nonceRoundTrip === true) return
    if (this.nonceRoundTrip === undefined) {
      const stored = await this.store.get!(entry.id)
      this.nonceRoundTrip = stored?.nonce === entry.nonce
    }
    if (!this.nonceRoundTrip) throw this.nonceLost()
  }

  private nonceLost(): TypeError {
    return new TypeError(
      `Audit integrity \`erasable\`: the store (${this.store.constructor.name}) does not persist the entry \`nonce\` — ` +
        'add the `nonce` column (see the store README) before enabling `erasable`; v3 entries written without it cannot be verified.',
    )
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

  private build(source: AuditEntry['source'], event: string, payload: unknown, scope?: AuditRecordScope): AuditEntry {
    const context = tryCtx()
    const user = context?.['user'] as { id?: string } | undefined
    const tenant = context?.['tenant'] as { id?: string } | undefined
    const { actorId, tenantId } = resolveRecordScope(user?.id, tenant?.id, scope)
    return Object.freeze({
      id: randomUUID(),
      source,
      event,
      payload: frozenPayload(this.redactor(this.minimize(payload, event), event)),
      actorId,
      tenantId,
      requestId: context?.requestId,
      ...this.requestFields(context, event),
      at: Date.now(),
    })
  }

  /** Applies the event's {@link AuditFieldPolicy}, if it has one (before the redactor). */
  private minimize(payload: unknown, event: string): unknown {
    const policy = this.fieldPolicies.get(event)
    return policy === undefined ? payload : applyFieldPolicy(payload, policy, this.fieldPolicyKey ?? processKey())
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
    const scrubbed = this.redactor({ ...(ip ? { ip } : {}), ...(userAgent ? { userAgent } : {}) }, event)
    if (scrubbed === null || typeof scrubbed !== 'object') return {}
    const out = scrubbed as Record<string, unknown>
    const fields: AuditRequestInfo = {}
    if (typeof out['ip'] === 'string') fields.ip = out['ip']
    if (typeof out['userAgent'] === 'string') fields.userAgent = out['userAgent']
    return fields
  }
}

/**
 * The signing key and the verification ring of a keyed integrity option.
 * Validated up front: a key id outside the grammar would produce hashes the
 * verifier cannot parse, and two different keys under one id would make
 * verification depend on which one happened to win.
 */
function keyRing(integrity: AuditHashChainIntegrity): {
  signer: AuditSigningKey | undefined
  verifyKeys: ReadonlyMap<string, AuditIntegrityKey>
} {
  const { key, keyId, verifyKeys } = integrity
  if (key === undefined) {
    if (keyId !== undefined) throw new TypeError('Audit integrity `keyId` needs a `key` to sign with')
    if (verifyKeys !== undefined && verifyKeys.length > 0) {
      throw new TypeError(
        'Audit integrity `verifyKeys` needs a `key`: without one new entries would be unkeyed SHA-256, which a keyed verifier refuses',
      )
    }
    return { signer: undefined, verifyKeys: new Map() }
  }
  assertIntegrityKey(key)
  if (verifyKeys !== undefined && !Array.isArray(verifyKeys)) {
    throw new TypeError('Audit integrity `verifyKeys` must be an array of keys or { id, key }')
  }
  const signer: AuditSigningKey = { id: keyId ?? auditKeyId(key), key }
  assertAuditKeyId(signer.id)
  const ring = new Map<string, AuditIntegrityKey>([[signer.id, key]])
  for (const item of verifyKeys ?? []) {
    const pair: AuditSigningKey =
      typeof item === 'string' || item instanceof Uint8Array ? { id: auditKeyId(item), key: item } : item
    if (pair === null || typeof pair !== 'object') throw new TypeError('Audit integrity `verifyKeys` entries must be a key or { id, key }')
    assertIntegrityKey(pair.key)
    assertAuditKeyId(pair.id)
    const existing = ring.get(pair.id)
    if (existing !== undefined && !Buffer.from(existing).equals(Buffer.from(pair.key))) {
      throw new TypeError(`Audit integrity key id "${pair.id}" is used by two different keys`)
    }
    ring.set(pair.id, pair.key)
  }
  return { signer, verifyKeys: ring }
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
   * Default: auth, billing, tenancy and permission activity, minus
   * {@link DEFAULT_AUDIT_HOOK_EXCLUDES}.
   *
   * A plain list is the `include` set. The object form adds `exclude`: a hook
   * is recorded when it matches an `include` pattern and no `exclude` pattern.
   * When `exclude` is omitted the default excludes apply; a hook named exactly
   * (no wildcard) in `include` is always recorded, which is how an app opts a
   * default-excluded hook back in (`['auth:**', 'auth:apikey_rejected']`).
   * `exclude: []` turns the default excludes off.
   */
  hooks?: string[] | AuditHookSelection
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

  /** Per-event personal-data policy: see {@link AuditOptions.fieldPolicies}. */
  fieldPolicies?: AuditFieldPolicies

  /** Keys the pseudonyms of `fieldPolicies`: see {@link AuditOptions.fieldPolicyKey}. */
  fieldPolicyKey?: PseudonymizationKey
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

/** The include/exclude form of {@link AuditPluginOptions.hooks}. */
export interface AuditHookSelection {
  include: string[]
  /** Default: {@link DEFAULT_AUDIT_HOOK_EXCLUDES}. */
  exclude?: string[]
}

/**
 * Hooks left out of the automatic capture unless named explicitly.
 *
 * `auth:apikey_rejected` fires for every request that presents a key which
 * does not verify, before anyone is authenticated. Captured by `auth:**`, it
 * let any anonymous client append to the audit trail (and to its serialized
 * per-tenant hash chain) as fast as it could send requests. Refusals of a key
 * that DID verify (tenant mismatch, scope) are rare and attributable, but they
 * share the event; an app that wants them records the hook explicitly, ideally
 * behind its own throttle.
 */
export const DEFAULT_AUDIT_HOOK_EXCLUDES: readonly string[] = ['auth:apikey_rejected']

const hasWildcard = (pattern: string): boolean => pattern.includes('*')

/** Compiles `AuditPluginOptions.hooks` into a predicate. */
function hookSelector(option: string[] | AuditHookSelection | undefined): (hook: string) => boolean {
  const include = Array.isArray(option) ? option : (option?.include ?? DEFAULT_HOOK_PATTERNS)
  const exclude = Array.isArray(option) || option?.exclude === undefined ? DEFAULT_AUDIT_HOOK_EXCLUDES : option.exclude
  const explicit = new Set(include.filter((pattern) => !hasWildcard(pattern)))
  return (hook) => {
    if (explicit.has(hook)) return true
    if (!include.some((pattern) => patternMatches(pattern, hook))) return false
    return !exclude.some((pattern) => patternMatches(pattern, hook))
  }
}

export function auditPlugin(options: AuditPluginOptions = {}) {
  // Fail at configuration time, not on the first resolution of AUDIT.
  compileFieldPolicies(options.fieldPolicies, options.fieldPolicyKey)
  const selectHook = hookSelector(options.hooks)
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
        ...(options.fieldPolicies !== undefined ? { fieldPolicies: options.fieldPolicies } : {}),
        ...(options.fieldPolicyKey !== undefined ? { fieldPolicyKey: options.fieldPolicyKey } : {}),
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
        if (!selectHook(hook)) return
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
  const unchained =
    (r.redacted > 0 ? `, ${r.redacted} redacted` : '') + (r.unchained > 0 ? `, ${r.unchained} unchained row(s)` : '')
  if (!r.ok && r.reason === 'unchained-entry') {
    return `${chain}: BROKEN — ${r.unverified.length} row(s) outside the chain written after it began (e.g. entry ${String(r.entryId)}); ${r.checked} chained entr${r.checked === 1 ? 'y' : 'ies'} verified`
  }
  return r.ok
    ? `${chain}: ok — ${r.checked} entr${r.checked === 1 ? 'y' : 'ies'} verified${r.head ? `, head #${r.head.seq} ${r.head.hash}` : ''}${unchained}`
    : `${chain}: BROKEN at seq ${String(r.firstBrokenAt)} (${String(r.reason)}${r.detail ? `: ${r.detail}` : ''})${r.entryId ? ` entry ${r.entryId}` : ''} — ${r.checked} verified before it${unchained}`
}

/**
 * The `audit:verify` command, as a plain `@basaltkit/cli` command definition.
 * `auditPlugin({ integrity: 'hash-chain' })` registers it automatically; call
 * this yourself to register it elsewhere (e.g. `cliPlugin([createAuditVerifyCommand(...)])`).
 *
 * `basalt audit:verify [--tenant=<id>] [--from=<seq>] [--to=<seq>]` verifies one
 * chain (the system chain without `--tenant`); `--all` verifies every chain.
 * `--expected-head=<seq>:<hash>` checks one chain against an anchor recorded
 * elsewhere (detects truncation); `--legacy-until=<ms>` sets the legacy cut-off
 * for rows outside the chain (`0` = none are legacy). Exits 1 when any chain is broken.
 */
export function createAuditVerifyCommand(getAudit: () => Audit) {
  // A CLI parser hands `--all` over as `true`, but `--all=true` as the string
  // 'true' — and `flags.all === true` used to read that as "not --all" and
  // verify only the system chain (exit 0). Anything unrecognised is an error.
  const bool = (value: string | boolean | undefined, name: string): boolean => {
    if (value === undefined || value === false) return false
    if (value === true) return true
    const v = value.trim().toLowerCase()
    if (v === '' || v === 'true' || v === '1' || v === 'yes') return true
    if (v === 'false' || v === '0' || v === 'no') return false
    throw new TypeError(`--${name} must be a boolean (true/false), got "${value}"`)
  }
  const int = (value: string | boolean, name: string): number => {
    const n = Number(value)
    if (!Number.isSafeInteger(n) || n < 1) throw new TypeError(`--${name} must be a positive integer`)
    return n
  }
  return {
    name: 'audit:verify',
    description:
      'Verify the audit trail hash chain (--tenant=<id> | --all, --from/--to=<seq>, --expected-head=<seq>:<hash>, --legacy-until=<ms>)',
    async handle({ flags, io }: AuditVerifyCommandContext): Promise<number> {
      const all = bool(flags['all'], 'all')
      if (flags['tenant'] !== undefined && (typeof flags['tenant'] !== 'string' || flags['tenant'] === '')) {
        // `--tenant` with no value used to fall through to the system chain.
        throw new TypeError('--tenant needs a tenant id (--tenant=<id>)')
      }
      if (all) {
        const single = ['tenant', 'from', 'to', 'expected-head'].filter((f) => flags[f] !== undefined)
        if (single.length > 0) {
          throw new TypeError(`--all cannot be combined with ${single.map((f) => `--${f}`).join(', ')} (they select one chain)`)
        }
      }
      const audit = getAudit()
      let legacyUntil: number | undefined
      if (flags['legacy-until'] !== undefined) {
        legacyUntil = Number(flags['legacy-until'])
        if (!Number.isSafeInteger(legacyUntil) || legacyUntil < 0) {
          throw new TypeError('--legacy-until must be a non-negative integer (epoch milliseconds)')
        }
      }
      let expectedHead: AuditChainHead | undefined
      if (flags['expected-head'] !== undefined) {
        // `<seq>:<hash>` — split on the FIRST colon only: a v2 hash has its own
        // (`v2:hmac-sha256:<keyId>:<hex>`).
        const match = /^(\d+):(.+)$/.exec(String(flags['expected-head']))
        if (!match || parseAuditHash(match[2]) === undefined) {
          throw new TypeError('--expected-head must be <seq>:<hash>, the head printed by a previous audit:verify')
        }
        expectedHead = { seq: int(match[1]!, 'expected-head'), hash: match[2]! }
      }
      const legacy = legacyUntil !== undefined ? { legacyUntil } : {}
      const results =
        all
          ? (await audit.verifyAll(legacy)).chains
          : [
              await audit.verify({
                ...(typeof flags['tenant'] === 'string' ? { tenantId: flags['tenant'] } : {}),
                ...(flags['from'] !== undefined ? { from: int(flags['from'], 'from') } : {}),
                ...(flags['to'] !== undefined ? { to: int(flags['to'], 'to') } : {}),
                ...(expectedHead !== undefined ? { expectedHead } : {}),
                ...legacy,
              }),
            ]
      for (const r of results) (r.ok ? io.log : io.error)(describeResult(r))
      return results.every((r) => r.ok) ? 0 : 1
    },
  }
}
