import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { DriveSecretKeyInvalidError, DriveSecretKeyUnknownError, DriveSecretMalformedError } from './errors.js'

/**
 * Authenticated encryption (AES-256-GCM) for the OAuth tokens this package
 * stores at rest.
 *
 * ## Relation to `@basaltkit/auth`'s `SecretBox`
 *
 * `@basaltkit/auth` now ships a `SecretBox` for TOTP secrets built on the same
 * model — HKDF-derived keys, a key ring with ids, AAD binding to the owning
 * record, and no plaintext path unless a legacy migration is opted into. The
 * two are still separate implementations because neither package may depend
 * on the other; RFC 0002 proposes promoting one into a lower layer so both
 * share it.
 *
 * ## Envelope
 *
 *     bkd1.<keyId>.<iv>.<tag>.<ciphertext>
 *
 * all but the version and key id base64url. The key id travels in the clear on
 * purpose — it is how a rotated ring still reads old rows — and it is covered
 * by the GCM tag through the AAD, so it cannot be swapped.
 */

const VERSION = 'bkd1'
/** A label mixed into HKDF so key material reused elsewhere derives a different box key. */
const HKDF_INFO = 'basalt:drives:credentials:v1'
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/

/** One entry of the key ring. */
export interface DriveEncryptionKey {
  /**
   * Stable identifier stored with every ciphertext. Keep it forever: dropping a
   * key id from the ring makes every row sealed with it unreadable.
   */
  id: string
  /**
   * Key material. Any length ≥ 32 bytes (or 32+ characters); the AES key is
   * derived with HKDF-SHA256, so this is never used raw.
   */
  key: string | Uint8Array
}

/** Everything a ciphertext is bound to. Changing any field makes it undecryptable. */
export interface DriveSecretContext {
  tenantId: string
  connectionId: string
  provider: string
}

const MIN_KEY_BYTES = 32

const toKeyMaterial = (key: string | Uint8Array): Buffer =>
  typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key)

/**
 * Associated data: the row the ciphertext belongs to. GCM authenticates it
 * without storing it, so a blob lifted into another tenant's row fails the tag
 * check instead of decrypting. NUL-separated because none of the three fields
 * may contain a NUL, which keeps the encoding unambiguous (`a|b` + `c` must not
 * collide with `a` + `b|c`).
 */
const aad = (keyId: string, context: DriveSecretContext): Buffer => {
  // The separator is only unambiguous if it cannot occur inside a field, so
  // that is checked rather than assumed: ids come from a store and a tenancy
  // resolver this package does not control.
  for (const field of [context.tenantId, context.connectionId, context.provider]) {
    if (field.includes('\0')) throw new DriveSecretMalformedError('the credential context contains a NUL character.')
  }
  return Buffer.from([VERSION, keyId, context.tenantId, context.connectionId, context.provider].join('\0'), 'utf8')
}

/** GCM's full tag. Anything shorter is refused: see {@link DriveSecretBox.open}. */
const TAG_BYTES = 16

/**
 * Seals and opens credential blobs against a key ring.
 *
 * The first key in the ring is the **active** one: everything new is sealed
 * with it. Every other key stays readable, which is what makes rotation a
 * rolling change rather than a migration — add the new key at the front, let
 * `reseal` move rows over as they are touched, and drop the old key once no row
 * references it.
 */
export class DriveSecretBox {
  private readonly keys = new Map<string, Buffer>()
  private readonly activeId: string

  constructor(ring: readonly DriveEncryptionKey[]) {
    if (ring.length === 0) throw new DriveSecretKeyInvalidError('at least one key is required.')
    for (const entry of ring) {
      if (!KEY_ID.test(entry.id)) {
        throw new DriveSecretKeyInvalidError(
          `key id ${JSON.stringify(entry.id)} must match ${String(KEY_ID)} (it is stored in the ciphertext envelope).`,
        )
      }
      if (this.keys.has(entry.id)) throw new DriveSecretKeyInvalidError(`duplicate key id "${entry.id}".`)
      const material = toKeyMaterial(entry.key)
      if (material.length < MIN_KEY_BYTES) {
        throw new DriveSecretKeyInvalidError(
          `key "${entry.id}" is ${material.length} bytes; at least ${MIN_KEY_BYTES} are required.`,
        )
      }
      // HKDF rather than a bare SHA-256 of the passphrase: it is the operation
      // actually specified for turning key material into a key, and the `info`
      // label domain-separates this box from any other use of the same secret.
      this.keys.set(entry.id, Buffer.from(hkdfSync('sha256', material, Buffer.alloc(0), HKDF_INFO, 32)))
    }
    this.activeId = ring[0]!.id
  }

  /** The key id new ciphertexts are sealed with. */
  get activeKeyId(): string {
    return this.activeId
  }

  /** Encrypts `plaintext`, binding it to `context`. */
  seal(plaintext: string, context: DriveSecretContext): string {
    const key = this.keys.get(this.activeId)!
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    cipher.setAAD(aad(this.activeId, context))
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return [VERSION, this.activeId, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.')
  }

  /**
   * Decrypts an envelope. Throws {@link DriveSecretMalformedError} for anything
   * that is not a well-formed envelope or whose tag does not verify — including
   * a blob bound to a different tenant, connection or provider. There is no
   * path that returns the input unchanged.
   */
  open(envelope: string, context: DriveSecretContext): string {
    const parts = envelope.split('.')
    if (parts.length !== 5 || parts[0] !== VERSION) {
      throw new DriveSecretMalformedError('not a recognisable credential envelope.')
    }
    const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string]
    const key = this.keys.get(keyId)
    if (!key) throw new DriveSecretKeyUnknownError(keyId)
    const additional = aad(keyId, context)
    const tag = Buffer.from(tagB64, 'base64url')
    let plaintext: Buffer
    try {
      // GCM accepts a tag as short as 4 bytes unless it is told otherwise, and
      // every byte shaved off halves the work of forging one. We only ever
      // write 16, so 16 is all that is read — pinned twice, because the length
      // check is the part that does not depend on the OpenSSL build.
      if (tag.length !== TAG_BYTES) throw new Error('truncated tag')
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'), {
        authTagLength: TAG_BYTES,
      })
      decipher.setAAD(additional)
      decipher.setAuthTag(tag)
      plaintext = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()])
    } catch {
      // One message for every failure mode: a wrong key, a tampered tag and a
      // ciphertext lifted from another row must be indistinguishable to a
      // caller, and the underlying OpenSSL text says nothing useful anyway.
      throw new DriveSecretMalformedError('authentication failed (wrong key, tampering, or a blob from another connection).')
    }
    return plaintext.toString('utf8')
  }

  /** Which key id sealed this envelope, without decrypting it. */
  keyIdOf(envelope: string): string | null {
    const parts = envelope.split('.')
    return parts.length === 5 && parts[0] === VERSION ? (parts[1] as string) : null
  }

  /**
   * Re-seals an envelope under the active key when it is not already, for
   * rolling rotation. Returns `null` when nothing needed to change, so a caller
   * can skip the write.
   */
  reseal(envelope: string, context: DriveSecretContext): string | null {
    if (this.keyIdOf(envelope) === this.activeId) return null
    return this.seal(this.open(envelope, context), context)
  }
}

/**
 * Timing-safe string comparison for values an attacker can submit repeatedly —
 * a webhook `clientState`, a channel token. Length is not secret here (both
 * sides are fixed-size generated values), so an early length exit is fine.
 */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/** A 32-byte url-safe random token — channel secrets, PKCE verifiers, state nonces. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
