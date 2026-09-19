import { createHash, createHmac } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'
import type { AuditEntry } from './index.js'

/**
 * Hash-chain primitives for a verifiable audit trail.
 *
 * Every chained entry carries `seq` (its position in the chain, from 1),
 * `prevHash` (the previous entry's `hash`, or {@link AUDIT_CHAIN_GENESIS} for the
 * first) and `hash` = SHA-256 (or HMAC-SHA256 under a key) over
 * `prevHash + "\n" + canonicalAuditEntry(entry)`. Chains are per tenant, plus one
 * for entries recorded without a tenant (the system chain).
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

/**
 * Canonical, stable serialization of every field the hash covers. Explicit
 * field list (never "whatever keys the object has"), sorted keys, `null` for an
 * absent optional, and a format version so the scheme can evolve.
 */
export function canonicalAuditEntry(entry: AuditEntry): string {
  return stableJson({
    v: 1,
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
  })
}

/** An integrity key: a secret of at least 128 bits. */
export type AuditIntegrityKey = string | Uint8Array

export function assertIntegrityKey(key: AuditIntegrityKey): void {
  if (typeof key !== 'string' && !(key instanceof Uint8Array)) {
    throw new TypeError('Audit integrity key must be a string or a Uint8Array')
  }
  const bytes = typeof key === 'string' ? Buffer.byteLength(key) : key.byteLength
  if (bytes < 16) throw new TypeError('Audit integrity key must be at least 16 bytes (128 bits)')
}

/**
 * The hash of `entry` given its `prevHash` (genesis when absent): SHA-256, or
 * HMAC-SHA256 when a `key` is given (then a database writer without the key
 * cannot recompute a self-consistent chain after tampering).
 */
export function computeAuditHash(entry: AuditEntry, key?: AuditIntegrityKey): string {
  const material = `${entry.prevHash ?? AUDIT_CHAIN_GENESIS}\n${canonicalAuditEntry(entry)}`
  return (key === undefined ? createHash('sha256') : createHmac('sha256', key)).update(material).digest('hex')
}
