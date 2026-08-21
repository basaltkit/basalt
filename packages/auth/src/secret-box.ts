import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/**
 * Authenticated encryption (AES-256-GCM) for secrets stored at rest — used to
 * encrypt TOTP secrets so a database leak doesn't hand the attacker every
 * user's live second factor.
 *
 * The wire format is `v1:<iv>:<tag>:<ciphertext>` (each base64). A value with no
 * `v1:` prefix is treated as legacy plaintext and returned as-is on decrypt, so
 * existing records keep working and get encrypted the next time they're written.
 */

const PREFIX = 'v1:'

/** Derive a 32-byte AES key from an arbitrary-length passphrase/key material. */
export function deriveKey(key: string | Buffer): Buffer {
  return createHash('sha256').update(key).digest()
}

/** Encrypt `plaintext` with AES-256-GCM. Returns the `v1:` envelope string. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

/**
 * Decrypt a `v1:` envelope. A value without the prefix is returned unchanged
 * (legacy plaintext, or encryption not configured). Throws if an enveloped
 * value fails authentication (tampering / wrong key).
 */
export function decryptSecret(value: string, key: Buffer): string {
  if (!value.startsWith(PREFIX)) return value
  const [, ivB64, tagB64, ctB64] = value.split(':')
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('Malformed encrypted secret.')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
}
