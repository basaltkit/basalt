import { randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The one browser session of a UI process (RFC 0009 §4.2): a one-time launch
 * code (in the URL fragment, valid 120 s) exchanged once for a session token
 * sent as `Authorization: Bearer`. The first exchange wins; any later one —
 * right code or not — is refused, and the terminal says so.
 */

export const LAUNCH_TTL_MS = 120_000
const SECRET_BYTES = 32

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
  | { ok: true; token: string }
  | { ok: false; status: 401 | 409; reason: string }

export class Session {
  readonly launchCode: string
  private readonly token: string
  private readonly createdAt: number
  private claimed = false

  constructor(
    private readonly now: () => number = Date.now,
    random: (size: number) => Buffer = nodeRandomBytes,
  ) {
    this.launchCode = random(SECRET_BYTES).toString('base64url')
    this.token = random(SECRET_BYTES).toString('base64url')
    this.createdAt = now()
  }

  get isClaimed(): boolean {
    return this.claimed
  }

  exchange(code: unknown): Exchange {
    if (this.claimed) return { ok: false, status: 409, reason: 'this UI already has its browser session; restart basalt-deploy-ui for a new one' }
    if (typeof code !== 'string' || !safeEqual(code, this.launchCode)) return { ok: false, status: 401, reason: 'wrong launch code' }
    if (this.now() - this.createdAt > LAUNCH_TTL_MS) return { ok: false, status: 401, reason: 'the launch code expired (120 s); restart basalt-deploy-ui' }
    this.claimed = true
    return { ok: true, token: this.token }
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
 * request and no open stream. An open stream holds it; closing the last one
 * restarts the count.
 */
export class IdleTimer {
  private handle: unknown
  private streams = 0
  private stopped = false

  constructor(private readonly ms: number, private readonly onIdle: () => void, private readonly timers: TimerApi = realTimers) {
    this.arm()
  }

  touch(): void {
    this.arm()
  }

  streamOpened(): void {
    this.streams++
    this.disarm()
  }

  streamClosed(): void {
    this.streams = Math.max(0, this.streams - 1)
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
    if (this.stopped || this.streams > 0) return
    this.handle = this.timers.set(() => {
      this.handle = undefined
      if (!this.stopped && this.streams === 0) this.onIdle()
    }, this.ms)
  }
}
