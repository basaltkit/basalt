import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { BasaltError } from '@basaltkit/core'

/**
 * Authenticated encryption (AES-256-GCM) for secrets stored at rest — used to
 * encrypt TOTP secrets so a database leak doesn't hand the attacker every
 * user's live second factor.
 *
 * ## Envelope
 *
 *     bka2.<keyId>.<iv>.<tag>.<ciphertext>
 *
 * all but the version and key id base64url. Compared with the `v1:` format it
 * replaces:
 *
 * - **Key ring with ids.** The first key is the active one; every other key
 *   stays readable, so rotation is rolling ({@link SecretBox.reseal}) instead
 *   of a flag day. The key id travels in the clear and is covered by the tag.
 * - **HKDF-SHA256**, domain-separated by a label, instead of a bare SHA-256 of
 *   the key material.
 * - **AAD binding.** Every ciphertext is bound to its record (a purpose and a
 *   subject — the user id for TOTP secrets): a blob copied into another user's
 *   row fails the tag check instead of decrypting there.
 * - **No plaintext path.** A value that is not an envelope is refused. Legacy
 *   `v1:` envelopes and plaintext values are readable only through an explicit
 *   {@link SecretBoxLegacyOptions} opt-in, meant for the migration window.
 *
 * Without the last point, anyone able to write the column could replace an
 * encrypted TOTP secret with a plaintext one they know (a downgrade), and the
 * box would hand it back as if it were genuine.
 */

const VERSION = 'bka2'
const LEGACY_PREFIX = 'v1:'
/** Mixed into HKDF so key material reused elsewhere derives a different box key. */
const HKDF_INFO = 'basalt:auth:secret-box:v2'
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/
const MIN_KEY_BYTES = 32
/** GCM's full tag; anything shorter is refused (a short tag is cheaper to forge). */
const TAG_BYTES = 16

/** A secret-box key or its value could not be used (configuration error). */
export class SecretBoxKeyError extends BasaltError {
  readonly status = 500
  readonly expose = false
  constructor(detail: string) {
    super('AUTH_SECRET_BOX_KEY_INVALID', `Invalid secret-box key configuration: ${detail}`)
  }
}

/**
 * A stored secret could not be opened: not an envelope (and no legacy opt-in),
 * an unknown key id, tampering, or a blob that belongs to another record. One
 * error for every case, so a caller cannot tell them apart.
 */
export class SecretUnreadableError extends BasaltError {
  readonly status = 500
  readonly expose = false
  constructor(detail: string) {
    super('AUTH_SECRET_UNREADABLE', `A stored secret could not be decrypted: ${detail}`)
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

/** What a ciphertext is bound to. Changing either field makes it undecryptable. */
export interface SecretContext {
  /** What the secret is for, e.g. `'totp'`. */
  purpose: string
  /** Whose secret it is, e.g. the user id. */
  subject: string
}

/**
 * Read-only compatibility with values written before the `bka2` envelope.
 * Accepting them re-opens the downgrade the envelope closes, so enable it only
 * while migrating ({@link SecretBox.reseal}) and remove it afterwards.
 */
export interface SecretBoxLegacyOptions {
  /** Keys of the old `v1:` envelopes (the former `mfaEncryptionKey`). */
  v1Keys?: ReadonlyArray<string | Uint8Array>
  /** Accept a value with no envelope at all as plaintext. */
  plaintext?: boolean
}

export interface SecretBoxOptions {
  /** The key ring; the first key seals everything new. */
  keys: readonly SecretBoxKey[]
  legacy?: SecretBoxLegacyOptions
}

const toBytes = (key: string | Uint8Array): Buffer => (typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key))

/** NUL-separated, so no field boundary can be shifted (`a|b`+`c` ≠ `a`+`b|c`). */
function aad(keyId: string, context: SecretContext): Buffer {
  for (const field of [context.purpose, context.subject]) {
    if (typeof field !== 'string' || field.length === 0 || field.includes('\0')) {
      throw new SecretUnreadableError('the secret context must be non-empty strings without NUL characters.')
    }
  }
  return Buffer.from([VERSION, keyId, context.purpose, context.subject].join('\0'), 'utf8')
}

/**
 * Seals and opens secrets against a key ring. See the module comment for the
 * envelope and the threat model.
 */
export class SecretBox {
  private readonly keys = new Map<string, Buffer>()
  private readonly activeId: string
  private readonly v1Keys: Buffer[]
  private readonly acceptPlaintext: boolean

  constructor(options: SecretBoxOptions) {
    const ring = options.keys
    if (!Array.isArray(ring) || ring.length === 0) throw new SecretBoxKeyError('at least one key is required.')
    for (const entry of ring) {
      if (typeof entry?.id !== 'string' || !KEY_ID.test(entry.id)) {
        throw new SecretBoxKeyError(`key id ${JSON.stringify(entry?.id)} must match ${String(KEY_ID)}.`)
      }
      if (this.keys.has(entry.id)) throw new SecretBoxKeyError(`duplicate key id "${entry.id}".`)
      const material = toBytes(entry.key)
      if (material.length < MIN_KEY_BYTES) {
        throw new SecretBoxKeyError(`key "${entry.id}" is ${material.length} bytes; at least ${MIN_KEY_BYTES} are required.`)
      }
      this.keys.set(entry.id, Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0), HKDF_INFO, 32)))
    }
    this.activeId = ring[0]!.id
    // The v1 format derived its key with a bare SHA-256; reproduced only to read old rows.
    this.v1Keys = (options.legacy?.v1Keys ?? []).map((k) => createHash('sha256').update(toBytes(k)).digest())
    this.acceptPlaintext = options.legacy?.plaintext === true
  }

  /** The key id new ciphertexts are sealed with. */
  get activeKeyId(): string {
    return this.activeId
  }

  /** Encrypts `plaintext` under the active key, bound to `context`. */
  seal(plaintext: string, context: SecretContext): string {
    const key = this.keys.get(this.activeId)!
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    cipher.setAAD(aad(this.activeId, context))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return [VERSION, this.activeId, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.')
  }

  /**
   * Decrypts a value sealed for `context`. Throws {@link SecretUnreadableError}
   * for anything else — including plaintext and `v1:` values unless the
   * matching legacy opt-in is set.
   */
  open(value: string, context: SecretContext): string {
    if (typeof value !== 'string') throw new SecretUnreadableError('not a string.')
    if (value.startsWith(`${VERSION}.`)) return this.openV2(value, context)
    if (value.startsWith(LEGACY_PREFIX)) return this.openV1(value)
    if (this.acceptPlaintext) return value
    throw new SecretUnreadableError('the value is not an encrypted envelope (plaintext is refused).')
  }

  /** Whether `value` is already sealed with the active key (nothing to migrate). */
  isCurrent(value: string): boolean {
    const parts = value.split('.')
    return parts.length === 5 && parts[0] === VERSION && parts[1] === this.activeId
  }

  /**
   * Re-seals `value` under the active key — for rotation, and for migrating
   * `v1:` / plaintext values (which requires the legacy opt-in to read them).
   * Returns `null` when the value is already current, so a caller can skip the
   * write.
   */
  reseal(value: string, context: SecretContext): string | null {
    if (this.isCurrent(value)) {
      this.open(value, context) // still authenticate it: never vouch for a blob that does not open
      return null
    }
    return this.seal(this.open(value, context), context)
  }

  private openV2(value: string, context: SecretContext): string {
    const parts = value.split('.')
    if (parts.length !== 5) throw new SecretUnreadableError('malformed envelope.')
    const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string]
    const key = this.keys.get(keyId)
    if (!key) throw new SecretUnreadableError(`unknown key id "${keyId}" (was it removed from the ring?).`)
    const additional = aad(keyId, context)
    try {
      const tag = Buffer.from(tagB64, 'base64url')
      if (tag.length !== TAG_BYTES) throw new Error('truncated tag')
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'), { authTagLength: TAG_BYTES })
      decipher.setAAD(additional)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8')
    } catch {
      throw new SecretUnreadableError('authentication failed (wrong key, tampering, or a value from another record).')
    }
  }

  private openV1(value: string): string {
    if (this.v1Keys.length === 0) throw new SecretUnreadableError('a legacy v1 envelope, and no legacy v1 key is configured.')
    const [, ivB64, tagB64, ctB64] = value.split(':')
    if (!ivB64 || !tagB64 || !ctB64) throw new SecretUnreadableError('malformed legacy envelope.')
    for (const key of this.v1Keys) {
      try {
        const tag = Buffer.from(tagB64, 'base64')
        if (tag.length !== TAG_BYTES) break
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'), { authTagLength: TAG_BYTES })
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
      } catch {
        // try the next legacy key
      }
    }
    throw new SecretUnreadableError('authentication failed for the legacy envelope.')
  }
}
