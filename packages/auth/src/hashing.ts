import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>

// scrypt needs ~128 * N * r bytes; Node's default maxmem (32 MiB) is exceeded
// at N >= 2^16, which would throw. Raise the ceiling to ~512 MiB so both the
// default cost and any higher-N hash (up to 2^17) derive and verify cleanly.
const MAXMEM = 512 * 1024 * 1024

export interface PasswordHasher {
  hash(plain: string): Promise<string>
  verify(plain: string, hashed: string): Promise<boolean>
}

/**
 * Default hasher: scrypt from node:crypto — memory-hard, zero dependencies.
 * An argon2id driver can be swapped in via the same contract (native module,
 * left out of the core install).
 *
 * The default cost is N=2^16 (r=8, p=1) — ~64 MiB per hash. The parameters are
 * embedded in every hash, so raising them here never breaks verification of
 * older, cheaper hashes; those simply verify at their stored cost.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  constructor(
    private readonly params: { N: number; r: number; p: number } = { N: 65536, r: 8, p: 1 },
  ) {}

  async hash(plain: string): Promise<string> {
    const salt = randomBytes(16)
    const derived = await scryptAsync(plain, salt, 32, { ...this.params, maxmem: MAXMEM })
    const { N, r, p } = this.params
    return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${derived.toString('base64url')}`
  }

  async verify(plain: string, hashed: string): Promise<boolean> {
    const parts = hashed.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const [, n, r, p, salt, expected] = parts as [string, string, string, string, string, string]
    const derived = await scryptAsync(plain, Buffer.from(salt, 'base64url'), 32, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAXMEM,
    })
    const expectedBuffer = Buffer.from(expected, 'base64url')
    return derived.length === expectedBuffer.length && timingSafeEqual(derived, expectedBuffer)
  }
}
