import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createSecretBox, SecretBoxError, type SecretBoxPrimitive } from '@basaltkit/core/secret-box'
import { DriveSecretKeyInvalidError, DriveSecretKeyUnknownError, DriveSecretMalformedError } from './errors.js'

/**
 * Authenticated encryption (AES-256-GCM) for the OAuth tokens this package
 * stores at rest.
 *
 * ## Relation to `@basaltkit/auth`'s `SecretBox`
 *
 * `@basaltkit/auth`'s `SecretBox` (TOTP secrets) and this box share one AEAD
 * implementation: `createSecretBox` from `@basaltkit/core/secret-box` (HKDF
 * keys, a key ring with ids, AAD binding to the owning record, no plaintext
 * path). Each keeps its own envelope version and HKDF label, so a ciphertext
 * of one never opens in the other; this class maps the primitive's failures
 * onto the `Drive*` errors.
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

/** The context as the primitive's ordered fields (tenant, connection, provider). */
const fields = (context: DriveSecretContext): [string, string, string] => [context.tenantId, context.connectionId, context.provider]

/** Maps a primitive failure onto the drives errors. */
function translate(error: unknown): never {
  if (error instanceof SecretBoxError) {
    if (error.failure === 'config') throw new DriveSecretKeyInvalidError(error.detail)
    if (error.failure === 'unknown-key') throw new DriveSecretKeyUnknownError(error.keyId ?? '')
    if (error.failure === 'context') throw new DriveSecretMalformedError('the credential context contains a NUL character.')
    if (error.failure === 'malformed') throw new DriveSecretMalformedError('not a recognisable credential envelope.')
    throw new DriveSecretMalformedError('authentication failed (wrong key, tampering, or a blob from another connection).')
  }
  throw error
}

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
  private readonly box: SecretBoxPrimitive

  constructor(ring: readonly DriveEncryptionKey[]) {
    try {
      this.box = createSecretBox({ keys: ring, info: HKDF_INFO, version: VERSION, aadFields: 3 })
    } catch (error) {
      translate(error)
    }
  }

  /** The key id new ciphertexts are sealed with. */
  get activeKeyId(): string {
    return this.box.activeKeyId
  }

  /** Encrypts `plaintext`, binding it to `context`. */
  seal(plaintext: string, context: DriveSecretContext): string {
    try {
      return this.box.seal(plaintext, fields(context))
    } catch (error) {
      translate(error)
    }
  }

  /**
   * Decrypts an envelope. Throws {@link DriveSecretMalformedError} for anything
   * that is not a well-formed envelope or whose tag does not verify — including
   * a blob bound to a different tenant, connection or provider — and
   * {@link DriveSecretKeyUnknownError} for a key id the ring does not hold.
   * There is no path that returns the input unchanged.
   */
  open(envelope: string, context: DriveSecretContext): string {
    try {
      return this.box.open(envelope, fields(context))
    } catch (error) {
      translate(error)
    }
  }

  /** Which key id sealed this envelope, without decrypting it. */
  keyIdOf(envelope: string): string | null {
    return this.box.keyIdOf(envelope)
  }

  /**
   * Re-seals an envelope under the active key when it is not already, for
   * rolling rotation. Returns `null` when nothing needed to change, so a caller
   * can skip the write — after authenticating the envelope, so a current blob
   * that does not open is reported instead of vouched for.
   */
  reseal(envelope: string, context: DriveSecretContext): string | null {
    try {
      return this.box.reseal(envelope, fields(context))
    } catch (error) {
      translate(error)
    }
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
