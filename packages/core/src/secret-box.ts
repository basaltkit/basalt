import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { BasaltError } from './errors.js'

/**
 * The shared AEAD primitive behind every Basalt "secret at rest" box
 * (`@basaltkit/auth`'s `SecretBox` for TOTP secrets, `@basaltkit/drives`'
 * `DriveSecretBox` for OAuth tokens). Exported from the
 * `@basaltkit/core/secret-box` subpath only, never from the main barrel.
 *
 * ## Envelope
 *
 *     <version>.<keyId>.<iv>.<tag>.<ciphertext>
 *
 * iv, tag and ciphertext base64url. AES-256-GCM with a 96-bit random IV and
 * the full 128-bit tag. Each box key is derived from its key material with
 * HKDF-SHA256 under a per-box `info` label, so the same material used by two
 * boxes yields two unrelated keys.
 *
 * ## Associated data
 *
 *     <version> NUL <keyId> NUL <context[0]> NUL … NUL <context[n-1]>
 *
 * The context binds a ciphertext to its record (a user, a tenant + connection):
 * a blob copied into another row fails the tag check instead of decrypting
 * there. The key id is covered too, so it cannot be swapped. NUL is refused
 * inside a field, which keeps the encoding unambiguous.
 *
 * There is no plaintext path: anything that is not an envelope of this box's
 * version is refused. Legacy formats are the wrapper's business.
 */

/** Why a {@link SecretBoxError} was raised — wrappers map it to their own errors. */
export type SecretBoxFailure =
  /** The box configuration (keys, version, info, field count) is unusable. */
  | 'config'
  /** Not an envelope of this box's version, or structurally malformed. */
  | 'malformed'
  /** The envelope names a key id the ring does not hold. */
  | 'unknown-key'
  /** The context has the wrong number of fields, or a field contains NUL. */
  | 'context'
  /** The tag did not verify: wrong key, tampering, or another record's blob. */
  | 'auth-failed'

export class SecretBoxError extends BasaltError {
  readonly status = 500
  readonly expose = false
  constructor(
    readonly failure: SecretBoxFailure,
    readonly detail: string,
    /** For `unknown-key`: the key id the envelope named. */
    readonly keyId?: string,
  ) {
    super('SECRET_BOX_ERROR', `Secret box: ${detail}`)
  }
}

/** One entry of the key ring. */
export interface SecretBoxKey {
  /**
   * Stable identifier stored with every ciphertext (`[A-Za-z0-9_-]{1,64}`).
   * Keep it in the ring as long as any row was sealed with it.
   */
  id: string
  /** Key material, at least 32 bytes. Never used raw: the AES key is derived with HKDF. */
  key: string | Uint8Array
}

export interface CreateSecretBoxOptions {
  /** The key ring; the first key seals everything new, every key opens. */
  keys: readonly SecretBoxKey[]
  /** HKDF `info` label, unique per box (e.g. `'basalt:auth:secret-box:v2'`). */
  info: string
  /** Envelope version tag, `[a-z0-9]{1,16}` (e.g. `'bka2'`). */
  version: string
  /** How many context fields every seal/open must pass. */
  aadFields: number
}

export interface SecretBoxPrimitive {
  /** The envelope version this box writes and reads. */
  readonly version: string
  /** The key id new ciphertexts are sealed with. */
  readonly activeKeyId: string
  /** Encrypts `plaintext` under the active key, bound to `context`. */
  seal(plaintext: string, context: readonly string[]): string
  /** Decrypts an envelope sealed for `context`; throws {@link SecretBoxError} otherwise. */
  open(envelope: string, context: readonly string[]): string
  /** Whether `envelope` has this box's shape and the active key id (no decryption). */
  isCurrent(envelope: string): boolean
  /** The key id an envelope of this box names, or null when it is not one. */
  keyIdOf(envelope: string): string | null
  /**
   * Re-seals `envelope` under the active key. Returns null when it is already
   * current — after authenticating it, so a blob that does not open is never
   * vouched for.
   */
  reseal(envelope: string, context: readonly string[]): string | null
}

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/
const VERSION_TAG = /^[a-z0-9]{1,16}$/
const MIN_KEY_BYTES = 32
/** GCM's full tag; anything shorter is refused (a short tag is cheaper to forge). */
const TAG_BYTES = 16

const toBytes = (key: string | Uint8Array): Buffer => (typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key))

/** Builds an AES-256-GCM box over a key ring. See the module comment. */
export function createSecretBox(options: CreateSecretBoxOptions): SecretBoxPrimitive {
  const { version, info, aadFields } = options
  if (typeof version !== 'string' || !VERSION_TAG.test(version)) {
    throw new SecretBoxError('config', `version ${JSON.stringify(version)} must match ${String(VERSION_TAG)}.`)
  }
  if (typeof info !== 'string' || info.length === 0) throw new SecretBoxError('config', 'info must be a non-empty string.')
  if (!Number.isInteger(aadFields) || aadFields < 1) throw new SecretBoxError('config', 'aadFields must be a positive integer.')
  const ring = options.keys
  if (!Array.isArray(ring) || ring.length === 0) throw new SecretBoxError('config', 'at least one key is required.')
  const keys = new Map<string, Buffer>()
  for (const entry of ring) {
    if (typeof entry?.id !== 'string' || !KEY_ID.test(entry.id)) {
      throw new SecretBoxError('config', `key id ${JSON.stringify(entry?.id)} must match ${String(KEY_ID)}.`)
    }
    if (keys.has(entry.id)) throw new SecretBoxError('config', `duplicate key id "${entry.id}".`)
    const material = toBytes(entry.key)
    if (material.length < MIN_KEY_BYTES) {
      throw new SecretBoxError('config', `key "${entry.id}" is ${material.length} bytes; at least ${MIN_KEY_BYTES} are required.`)
    }
    keys.set(entry.id, Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0), info, 32)))
  }
  const activeKeyId = ring[0]!.id

  const aad = (keyId: string, context: readonly string[]): Buffer => {
    if (!Array.isArray(context) || context.length !== aadFields) {
      throw new SecretBoxError('context', `the context must have exactly ${aadFields} field(s).`)
    }
    for (const field of context) {
      if (typeof field !== 'string' || field.includes('\0')) {
        throw new SecretBoxError('context', 'the context fields must be strings without NUL characters.')
      }
    }
    return Buffer.from([version, keyId, ...context].join('\0'), 'utf8')
  }

  const keyIdOf = (envelope: string): string | null => {
    if (typeof envelope !== 'string') return null
    const parts = envelope.split('.')
    return parts.length === 5 && parts[0] === version ? (parts[1] as string) : null
  }

  const seal = (plaintext: string, context: readonly string[]): string => {
    const key = keys.get(activeKeyId)!
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    cipher.setAAD(aad(activeKeyId, context))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return [version, activeKeyId, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.')
  }

  const open = (envelope: string, context: readonly string[]): string => {
    const keyId = keyIdOf(envelope)
    if (keyId === null) throw new SecretBoxError('malformed', 'not an encrypted envelope of this box.')
    const [, , ivB64, tagB64, ctB64] = envelope.split('.') as [string, string, string, string, string]
    const key = keys.get(keyId)
    if (!key) throw new SecretBoxError('unknown-key', `unknown key id "${keyId}" (was it removed from the ring?).`, keyId)
    const additional = aad(keyId, context)
    try {
      const tag = Buffer.from(tagB64, 'base64url')
      // GCM accepts tags as short as 4 bytes unless told otherwise; only the
      // full 16 we write are read — pinned twice, the length check being the
      // part that does not depend on the OpenSSL build.
      if (tag.length !== TAG_BYTES) throw new Error('truncated tag')
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'), { authTagLength: TAG_BYTES })
      decipher.setAAD(additional)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      // One message for every failure: a wrong key, a tampered tag and a blob
      // from another record must be indistinguishable to a caller.
      throw new SecretBoxError('auth-failed', 'authentication failed (wrong key, tampering, or a value from another record).')
    }
  }

  return {
    version,
    activeKeyId,
    seal,
    open,
    keyIdOf,
    isCurrent: (envelope) => keyIdOf(envelope) === activeKeyId,
    reseal(envelope, context) {
      if (keyIdOf(envelope) === activeKeyId) {
        open(envelope, context)
        return null
      }
      return seal(open(envelope, context), context)
    },
  }
}
