import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** RFC 4648 base32 encode (no padding, uppercase) — the format authenticator apps expect. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

/** RFC 4648 base32 decode — tolerant of lowercase, spaces, and `=` padding. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char)
    if (idx === -1) throw new Error('Invalid base32 character')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A fresh, random base32 TOTP secret (default 20 bytes = 160 bits). */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes))
}

export interface TotpOptions {
  /** Seconds per code. Default 30. */
  period?: number
  /** Code length. Default 6. */
  digits?: number
  /** Milliseconds since epoch. Default Date.now(). */
  now?: number
}

/** HOTP (RFC 4226) for an explicit counter. */
function hotp(secret: Buffer, counter: number, digits: number): string {
  const buf = Buffer.alloc(8)
  // 53-bit safe: counter never exceeds Number.MAX_SAFE_INTEGER for realistic times.
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const digest = createHmac('sha1', secret).update(buf).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff)
  return (binary % 10 ** digits).toString().padStart(digits, '0')
}

/** The current TOTP code (RFC 6238) for a base32 secret. */
export function totp(secret: string, options: TotpOptions = {}): string {
  const period = options.period ?? 30
  const digits = options.digits ?? 6
  const now = options.now ?? Date.now()
  const counter = Math.floor(now / 1000 / period)
  return hotp(base32Decode(secret), counter, digits)
}

export interface VerifyTotpOptions extends TotpOptions {
  /** Accept codes ±`window` steps to absorb clock drift. Default 1. */
  window?: number
}

/** True when `token` matches the TOTP within the allowed time window (constant-time). */
export function verifyTotp(secret: string, token: string, options: VerifyTotpOptions = {}): boolean {
  const period = options.period ?? 30
  const digits = options.digits ?? 6
  const now = options.now ?? Date.now()
  const window = options.window ?? 1
  const cleaned = token.replace(/\s/g, '')
  if (cleaned.length !== digits) return false

  const key = base32Decode(secret)
  const base = Math.floor(now / 1000 / period)
  let ok = false
  // Loop the whole window regardless of an early hit — no timing side channel.
  for (let error = -window; error <= window; error++) {
    const candidate = hotp(key, base + error, digits)
    if (candidate.length === cleaned.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(cleaned))) {
      ok = true
    }
  }
  return ok
}

export interface OtpauthUriInput {
  secret: string
  /** The account label, typically the user's email. */
  account: string
  /** The issuer shown in the authenticator app. */
  issuer: string
  digits?: number
  period?: number
}

/** Builds an `otpauth://totp/...` URI to render as a QR code. */
export function otpauthUri(input: OtpauthUriInput): string {
  // Label is `issuer:account`, each component encoded but the `:` kept literal.
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(input.digits ?? 6),
    period: String(input.period ?? 30),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}
