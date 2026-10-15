import { createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The one browser session of a UI process (RFC 0009 §4.2): a one-time launch
 * code (in the URL fragment, or typed with `--pair`; valid 120 s) exchanged once for a session token
 * sent as `Authorization: Bearer`. The first exchange wins; any later one —
 * right code or not — is refused, and the terminal says so.
 *
 * The exchange also hands the page a server key that the page never sends
 * back: the page checks this process with a challenge (HMAC of a fresh nonce)
 * before any answer leaves it. Once the UI has stopped, another local process
 * may bind the same port; it can have seen the bearer token, never the key.
 */

/** Bound into every proof, so a proof is never anything but this. */
export const PROOF_CONTEXT = 'basalt-deploy-ui hello v1\n'
export const NONCE = /^[A-Za-z0-9_-]{22,128}$/

export const LAUNCH_TTL_MS = 120_000
const SECRET_BYTES = 32

/**
 * `--pair` (RFC 0009 Q1): the browser opens the bare URL and the person types
 * a short code the terminal shows. Nothing secret passes through the opener's
 * or the browser's argv, which another local user can read. Eight characters
 * of an alphabet with no look-alikes (~40 bits), five tries, two minutes.
 */
export const PAIR_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const PAIR_LENGTH = 8
export const PAIR_TRIES = 5

/** What a person types, as the code is compared: upper case, without the separator or spaces. */
export const normalizePairCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '')

function pairCode(random: (size: number) => Buffer): string {
  let code = ''
  // Rejection sampling: 248 = 8 × 31, so every letter is equally likely.
  while (code.length < PAIR_LENGTH) {
    for (const byte of random(16)) {
      if (byte < 248 && code.length < PAIR_LENGTH) code += PAIR_ALPHABET[byte % PAIR_ALPHABET.length]
    }
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/** Constant time for equal lengths; a length mismatch is a plain refusal (the lengths are public). */
export function safeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    // Same work either way: compare b with itself.
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

export type Exchange =
  | { ok: true; token: string; serverKey: string }
  | { ok: false; status: 401 | 409 | 410 | 429; reason: string }

export class Session {
  readonly launchCode: string
  private readonly token: string
  private readonly serverKey: string
  private readonly createdAt: number
  private claimed = false
  private triesLeft = PAIR_TRIES

  constructor(
    private readonly now: () => number = Date.now,
    random: (size: number) => Buffer = nodeRandomBytes,
    readonly pair = false,
  ) {
    this.launchCode = pair ? pairCode(random) : random(SECRET_BYTES).toString('base64url')
    this.token = random(SECRET_BYTES).toString('base64url')
    this.serverKey = random(SECRET_BYTES).toString('base64url')
    this.createdAt = now()
  }

  get isClaimed(): boolean {
    return this.claimed
  }

  exchange(code: unknown): Exchange {
    if (this.claimed) return { ok: false, status: 409, reason: 'this UI already has its browser session; restart basalt-deploy-ui for a new one' }
    if (this.pair && this.triesLeft <= 0) return { ok: false, status: 429, reason: `${PAIR_TRIES} wrong pairing codes: restart basalt-deploy-ui for a new one` }
    const given = typeof code === 'string' && this.pair ? normalizePairCode(code) : code
    const expected = this.pair ? normalizePairCode(this.launchCode) : this.launchCode
    if (typeof given !== 'string' || !safeEqual(given, expected)) {
      if (!this.pair) return { ok: false, status: 401, reason: 'wrong launch code' }
      this.triesLeft--
      return { ok: false, status: this.triesLeft > 0 ? 401 : 429, reason: this.triesLeft > 0 ? `wrong pairing code (${this.triesLeft} ${this.triesLeft === 1 ? 'try' : 'tries'} left)` : `${PAIR_TRIES} wrong pairing codes: restart basalt-deploy-ui for a new one` }
    }
    if (this.now() - this.createdAt > LAUNCH_TTL_MS) return { ok: false, status: 410, reason: 'the launch code expired (120 s); restart basalt-deploy-ui' }
    this.claimed = true
    return { ok: true, token: this.token, serverKey: this.serverKey }
  }

  /** HMAC-SHA256(serverKey, context + nonce), base64url; undefined for a malformed nonce. */
  prove(nonce: unknown): string | undefined {
    if (typeof nonce !== 'string' || !NONCE.test(nonce)) return undefined
    return createHmac('sha256', Buffer.from(this.serverKey, 'base64url')).update(`${PROOF_CONTEXT}${nonce}`).digest('base64url')
  }

  /** `Authorization: Bearer <token>`, exactly. */
  authorizes(header: string | undefined): boolean {
    if (!this.claimed || header === undefined) return false
    const match = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header)
    return match !== null && safeEqual(match[1] as string, this.token)
  }
}

export interface TimerApi {
  set: (callback: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const realTimers: TimerApi = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Idle shutdown (RFC 0009 §4.5): fires after `ms` with no authenticated
 * request, no open stream and no remote command in flight. Each of those
 * holds it; releasing the last hold restarts the count.
 */
export class IdleTimer {
  private handle: unknown
  private holds = 0
  private stopped = false

  constructor(private readonly ms: number, private readonly onIdle: () => void, private readonly timers: TimerApi = realTimers) {
    this.arm()
  }

  touch(): void {
    this.arm()
  }

  /** An open stream or a remote command in flight: the UI is not idle. */
  hold(): void {
    this.holds++
    this.disarm()
  }

  release(): void {
    this.holds = Math.max(0, this.holds - 1)
    this.arm()
  }

  stop(): void {
    this.stopped = true
    this.disarm()
  }

  private disarm(): void {
    if (this.handle !== undefined) this.timers.clear(this.handle)
    this.handle = undefined
  }

  private arm(): void {
    this.disarm()
    if (this.stopped || this.holds > 0) return
    this.handle = this.timers.set(() => {
      this.handle = undefined
      if (!this.stopped && this.holds === 0) this.onIdle()
    }, this.ms)
  }
}
