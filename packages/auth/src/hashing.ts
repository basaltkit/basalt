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

/**
 * Ceilings on the scrypt cost a hash may declare. The parameters are read from
 * the STORED hash, so without a ceiling one planted or corrupted row (`N`, `r`
 * or `p` in the millions) would turn every login attempt on that account into
 * minutes of CPU on the libuv threadpool. Such a hash never verifies.
 */
const MAX_N = 2 ** 20
const MAX_R = 32
const MAX_P = 16

/** `true` when `N`/`r`/`p` are sane scrypt parameters within the cost ceilings. */
function acceptableParams(N: number, r: number, p: number): boolean {
  return (
    Number.isSafeInteger(N) && N > 1 && N <= MAX_N && (N & (N - 1)) === 0 &&
    Number.isSafeInteger(r) && r >= 1 && r <= MAX_R &&
    Number.isSafeInteger(p) && p >= 1 && p <= MAX_P &&
    128 * N * r <= MAXMEM
  )
}

const DECIMAL = /^[1-9][0-9]{0,9}$/

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
 * older, cheaper hashes; those simply verify at their stored cost. A stored
 * hash declaring more than N=2^20, r=32, p=16 (or more than 512 MiB) never
 * verifies, so a tampered row cannot pin the CPU.
 */
export class ScryptPasswordHasher implements PasswordHasher {
  constructor(
    private readonly params: { N: number; r: number; p: number } = { N: 65536, r: 8, p: 1 },
  ) {
    if (!acceptableParams(params.N, params.r, params.p)) {
      throw new RangeError(
        `ScryptPasswordHasher: N must be a power of two <= 2^20, r <= ${MAX_R}, p <= ${MAX_P} and 128*N*r <= 512 MiB`,
      )
    }
  }

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
    if (!DECIMAL.test(n) || !DECIMAL.test(r) || !DECIMAL.test(p)) return false
    const params = { N: Number(n), r: Number(r), p: Number(p) }
    if (!acceptableParams(params.N, params.r, params.p)) return false
    const derived = await scryptAsync(plain, Buffer.from(salt, 'base64url'), 32, { ...params, maxmem: MAXMEM })
    const expectedBuffer = Buffer.from(expected, 'base64url')
    return derived.length === expectedBuffer.length && timingSafeEqual(derived, expectedBuffer)
  }
}
