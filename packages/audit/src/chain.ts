import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'
import type { AuditEntry } from './index.js'

/**
 * Hash-chain primitives for a verifiable audit trail.
 *
 * Every chained entry carries `seq` (its position in the chain, from 1),
 * `prevHash` (the previous entry's `hash`, or {@link AUDIT_CHAIN_GENESIS} for the
 * first) and `hash`. Chains are per tenant, plus one for entries recorded without
 * a tenant (the system chain).
 *
 * Two hash formats coexist in one chain:
 *
 * - **v2** (every entry written since key ids were introduced) — self-describing:
 *   `v2:sha256:<hex>` or `v2:hmac-sha256:<keyId>:<hex>`. The digest covers
 *   `prevHash + "\n" + canonicalAuditEntry(entry, { alg, keyId })`, so the
 *   algorithm and the key id are part of what is authenticated. A verifier picks
 *   the key by id, which is what lets a key be rotated without invalidating the
 *   entries the previous key signed. See {@link computeAuditHashV2}.
 * - **v1** (legacy) — a bare 64-hex SHA-256 / HMAC-SHA256 over
 *   `prevHash + "\n" + canonicalAuditEntry(entry)`, naming neither. Still
 *   verified: under every key the verifier holds. See {@link computeAuditHash}.
 */

/** `prevHash` of the first entry of every chain. */
export const AUDIT_CHAIN_GENESIS = '0'.repeat(64)

/** Chain key of entries recorded without a tenant. */
export const AUDIT_SYSTEM_CHAIN = '@system'

/**
 * The durable chain identifier a store indexes `(chain, seq)` on. Never NULL —
 * SQL unique indexes treat NULLs as distinct, so the system chain needs a real
 * key to be protected against forks. The `t:` prefix keeps any tenant id from
 * colliding with {@link AUDIT_SYSTEM_CHAIN}.
 */
export function auditChainKey(tenantId: string | undefined): string {
  return tenantId === undefined ? AUDIT_SYSTEM_CHAIN : `t:${tenantId}`
}

/** Inverse of {@link auditChainKey}. */
export function parseAuditChainKey(key: string): string | undefined {
  return key === AUDIT_SYSTEM_CHAIN ? undefined : key.startsWith('t:') ? key.slice(2) : key
}

/**
 * Thrown by a store's `append` when `(chain, seq)` is already taken — another
 * writer (another replica, or another `Audit` instance) extended the chain
 * first. `Audit` re-reads the head and retries; stores must raise this (and not
 * silently accept a duplicate), otherwise concurrent writers fork the chain.
 */
export class AuditChainConflictError extends BasaltError {
  constructor(tenantId: string | undefined, seq: number | undefined, options?: ErrorOptions) {
    super(
      'AUDIT_CHAIN_CONFLICT',
      `Audit chain ${auditChainKey(tenantId)} already has an entry at seq ${String(seq)} (concurrent writer).`,
      options,
    )
  }
}

/** Serializes JSON-like data with object keys sorted at every level. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(',')}}`
}

/**
 * The payload exactly as a durable store persists it: through a JSON round-trip
 * (so `undefined` members vanish, dates become strings, …). Hashing this form —
 * not the in-memory object — is what makes the hash reproducible after a read.
 */
function persistedPayload(payload: unknown): unknown {
  if (payload === undefined) return null
  const json = JSON.stringify(payload)
  return json === undefined ? null : (JSON.parse(json) as unknown)
}

/** How a v2 entry's digest was produced. */
export type AuditHashAlgorithm = 'sha256' | 'hmac-sha256'

/**
 * The grammar of a key id: 1–64 characters of `A-Z a-z 0-9 . _ -`. It is
 * written into every v2 hash (`v2:hmac-sha256:<keyId>:<hex>`), so `:` and
 * whitespace are out, and it is kept short enough for a MySQL `VARCHAR(191)`.
 */
export const AUDIT_KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/**
 * Canonical, stable serialization of every field the hash covers. Explicit
 * field list (never "whatever keys the object has"), sorted keys, `null` for an
 * absent optional, and a format version so the scheme can evolve.
 *
 * Without `scheme` this is the v1 form. With it, the v2 form: the same fields
 * plus `alg` and `kid`, so the digest authenticates which algorithm and which
 * key produced it — relabelling an entry's key id breaks its hash.
 */
export function canonicalAuditEntry(
  entry: AuditEntry,
  scheme?: { alg: AuditHashAlgorithm; keyId?: string | undefined },
): string {
  const fields = {
    id: entry.id,
    seq: entry.seq ?? null,
    tenantId: entry.tenantId ?? null,
    at: entry.at,
    source: entry.source,
    event: entry.event,
    actorId: entry.actorId ?? null,
    requestId: entry.requestId ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    payload: persistedPayload(entry.payload),
  }
  return stableJson(
    scheme === undefined ? { v: 1, ...fields } : { v: 2, alg: scheme.alg, kid: scheme.keyId ?? null, ...fields },
  )
}

/** An integrity key: a secret of at least 128 bits. */
export type AuditIntegrityKey = string | Uint8Array

/** A key together with the id recorded in the entries it signs. */
export interface AuditSigningKey {
  id: string
  key: AuditIntegrityKey
}

export function assertIntegrityKey(key: AuditIntegrityKey): void {
  if (typeof key !== 'string' && !(key instanceof Uint8Array)) {
    throw new TypeError('Audit integrity key must be a string or a Uint8Array')
  }
  const bytes = typeof key === 'string' ? Buffer.byteLength(key) : key.byteLength
  if (bytes < 16) throw new TypeError('Audit integrity key must be at least 16 bytes (128 bits)')
}

/** Throws unless `id` matches {@link AUDIT_KEY_ID_PATTERN}. */
export function assertAuditKeyId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !AUDIT_KEY_ID_PATTERN.test(id)) {
    throw new TypeError('Audit integrity key id must be 1-64 characters of A-Z, a-z, 0-9, ".", "_" or "-"')
  }
}

/**
 * The default id of a key: `k-` + the first 64 bits of
 * HMAC-SHA256(key, "basalt:audit:key-id"). Deterministic, so every replica
 * configured with the same key records the same id without being told one,
 * and one-way, so the id reveals nothing usable about the key.
 */
export function auditKeyId(key: AuditIntegrityKey): string {
  assertIntegrityKey(key)
  return `k-${createHmac('sha256', key).update('basalt:audit:key-id').digest('hex').slice(0, 16)}`
}

/**
 * The legacy (v1) hash of `entry` given its `prevHash` (genesis when absent):
 * a bare 64-hex SHA-256, or HMAC-SHA256 when a `key` is given. It names neither
 * algorithm nor key. `Audit` no longer writes it — see {@link computeAuditHashV2}
 * — but still verifies entries that carry it.
 */
export function computeAuditHash(entry: AuditEntry, key?: AuditIntegrityKey): string {
  const material = `${entry.prevHash ?? AUDIT_CHAIN_GENESIS}\n${canonicalAuditEntry(entry)}`
  return (key === undefined ? createHash('sha256') : createHmac('sha256', key)).update(material).digest('hex')
}

/**
 * The v2 hash of `entry` given its `prevHash` (genesis when absent) — what
 * `Audit` writes. Without `signer`: `v2:sha256:<hex>`. With one:
 * `v2:hmac-sha256:<signer.id>:<hex>`, the HMAC under `signer.key` (then a
 * database writer without the key cannot recompute a self-consistent chain).
 * The algorithm and key id are both in the string and in the digested
 * canonical form, so a verifier holding several keys knows which one to use,
 * and nobody can relabel an entry to another key.
 */
export function computeAuditHashV2(entry: AuditEntry, signer?: AuditSigningKey): string {
  if (signer !== undefined) assertAuditKeyId(signer.id)
  const alg: AuditHashAlgorithm = signer === undefined ? 'sha256' : 'hmac-sha256'
  const material = `${entry.prevHash ?? AUDIT_CHAIN_GENESIS}\n${canonicalAuditEntry(entry, { alg, keyId: signer?.id })}`
  const digest = (signer === undefined ? createHash('sha256') : createHmac('sha256', signer.key)).update(material).digest('hex')
  return signer === undefined ? `v2:sha256:${digest}` : `v2:hmac-sha256:${signer.id}:${digest}`
}

/** A stored `hash`, split into its parts. */
export type ParsedAuditHash =
  | { version: 1; digest: string }
  | { version: 2; alg: 'sha256'; digest: string }
  | { version: 2; alg: 'hmac-sha256'; keyId: string; digest: string }

/** Parses a stored `hash`; `undefined` for anything that is neither format. */
export function parseAuditHash(hash: unknown): ParsedAuditHash | undefined {
  if (typeof hash !== 'string') return undefined
  if (/^[0-9a-f]{64}$/.test(hash)) return { version: 1, digest: hash }
  const plain = /^v2:sha256:([0-9a-f]{64})$/.exec(hash)
  if (plain) return { version: 2, alg: 'sha256', digest: plain[1]! }
  const keyed = /^v2:hmac-sha256:([A-Za-z0-9._-]{1,64}):([0-9a-f]{64})$/.exec(hash)
  if (keyed) return { version: 2, alg: 'hmac-sha256', keyId: keyed[1]!, digest: keyed[2]! }
  return undefined
}

/** Whether `value` is a well-formed stored hash (v1 or v2). */
export function isAuditHash(value: unknown): value is string {
  return parseAuditHash(value) !== undefined
}

/** Constant-time comparison of two hash strings (a mismatch in length is simply false). */
function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/**
 * Checks an entry's stored `hash` against the keys a verifier holds, keyed by
 * id (empty = an unkeyed chain):
 *
 * - v2 `hmac-sha256` — recomputed under the key its id names;
 *   `'unknown-key'` when the verifier does not hold that id.
 * - v2 `sha256` — accepted only by an unkeyed verifier. A keyed verifier
 *   refuses it as `'hash-mismatch'`: anyone can compute a plain SHA-256, so
 *   accepting one would let a writer without the key extend or rewrite the chain.
 * - v1 — an unkeyed verifier recomputes the SHA-256; a keyed one accepts the
 *   HMAC under ANY key it holds (v1 never recorded which).
 */
export function checkAuditHash(
  entry: AuditEntry,
  keys: ReadonlyMap<string, AuditIntegrityKey>,
): 'ok' | 'hash-mismatch' | 'unknown-key' {
  const parsed = parseAuditHash(entry.hash)
  if (parsed === undefined) return 'hash-mismatch'
  const stored = entry.hash as string
  if (parsed.version === 1) {
    if (keys.size === 0) return sameHash(computeAuditHash(entry), stored) ? 'ok' : 'hash-mismatch'
    for (const key of keys.values()) if (sameHash(computeAuditHash(entry, key), stored)) return 'ok'
    return 'hash-mismatch'
  }
  if (parsed.alg === 'sha256') {
    return keys.size === 0 && sameHash(computeAuditHashV2(entry), stored) ? 'ok' : 'hash-mismatch'
  }
  const key = keys.get(parsed.keyId)
  if (key === undefined) return 'unknown-key'
  return sameHash(computeAuditHashV2(entry, { id: parsed.keyId, key }), stored) ? 'ok' : 'hash-mismatch'
}
