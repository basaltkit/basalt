import type { StreamMessage } from './messages.js'

/**
 * The page's calls to its local server: POST, JSON, the session token as a
 * bearer header (never a cookie: cookies are not port-scoped). Streams are
 * POST too, read with fetch, NDJSON line by line.
 */

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> = {}) {
    super(message)
  }
}

/**
 * The local server is gone (`unreachable`: the UI stopped — idle, quit,
 * Ctrl-C) or is not the one this page was opened from (`unverified`: it
 * could not prove it knows the server key). The page stops: nothing more is
 * sent, and never an answer.
 */
export class ServerGone extends Error {
  constructor(readonly why: 'unreachable' | 'unverified', message: string) {
    super(message)
  }
}

/** The same string as the server's `PROOF_CONTEXT` (session.ts; a test keeps them equal). */
export const PROOF_CONTEXT = 'basalt-deploy-ui hello v1\n'

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** What the launch code is exchanged for: the bearer token (sent on every call) and the server key (never sent). */
export interface Credentials {
  token: string
  serverKey: string
}

export interface ApiOptions {
  /** The key the server proves itself with; without it, no answer is ever sent. */
  serverKey?: string
  /** WebCrypto (the page's `crypto`): the nonce and the HMAC check. */
  crypto?: Crypto
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>

const init = (body: unknown, token: string | undefined, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
  credentials: 'omit',
  cache: 'no-store',
  redirect: 'error',
  ...(signal ? { signal } : {}),
})

async function failure(response: Response): Promise<ApiError> {
  const type = response.headers.get('content-type') ?? ''
  try {
    if (type.startsWith('application/json')) {
      const body = (await response.json()) as Record<string, unknown>
      return new ApiError(response.status, typeof body['error'] === 'string' ? body['error'] : `HTTP ${response.status}`, body)
    }
    return new ApiError(response.status, (await response.text()).trim() || `HTTP ${response.status}`)
  } catch {
    return new ApiError(response.status, `HTTP ${response.status}`)
  }
}

/** Splits a byte stream into lines (UTF-8 across chunk boundaries). */
export async function readLines(body: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.trim() !== '') onLine(line)
    }
  }
  pending += decoder.decode()
  if (pending.trim() !== '') onLine(pending)
}

/** The launch code for the session's credentials, once. */
export async function exchange(code: string, fetchImpl: Fetch): Promise<Credentials> {
  const response = await fetchImpl('/api/session', init({ code }, undefined))
  if (!response.ok) throw await failure(response)
  const body = (await response.json()) as { token?: unknown; serverKey?: unknown }
  if (typeof body.token !== 'string' || typeof body.serverKey !== 'string') throw new ApiError(500, 'no token or no server key in the session reply')
  return { token: body.token, serverKey: body.serverKey }
}

const carriesAnswers = (body: Record<string, unknown>) => Array.isArray(body['answers']) && body['answers'].length > 0

export class Api {
  /** Called once, the first time the server is found gone or unverified. */
  onGone: ((error: ServerGone) => void) | undefined
  private gone: ServerGone | undefined

  constructor(private readonly token: string, private readonly fetchImpl: Fetch, private readonly options: ApiOptions = {}) {}

  /**
   * Checks that the server is the process this page was opened from: a fresh
   * random nonce, answered with HMAC-SHA256(serverKey, context + nonce).
   * Anything else — no key, no WebCrypto, a refusal, a wrong proof — and the
   * page stops.
   */
  async verifyServer(): Promise<void> {
    const crypto = this.options.crypto
    const serverKey = this.options.serverKey
    if (!serverKey || !crypto?.subtle) throw this.stop('unverified', 'this page cannot check its local server (no server key, or no WebCrypto): nothing is sent')
    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
    let proof: unknown
    try {
      proof = (await this.send<{ proof?: unknown }>('hello', { nonce })).proof
    } catch (error) {
      if (error instanceof ServerGone) throw error
      throw this.stop('unverified', 'the local server refused to prove it is this UI: it is not the one this page was opened from')
    }
    let valid = false
    if (typeof proof === 'string' && /^[A-Za-z0-9_-]{43}$/.test(proof)) {
      const key = await crypto.subtle.importKey('raw', fromBase64Url(serverKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
      valid = await crypto.subtle.verify('HMAC', key, fromBase64Url(proof), new TextEncoder().encode(`${PROOF_CONTEXT}${nonce}`))
    }
    if (!valid) throw this.stop('unverified', 'the local server could not prove it is this UI: another program may be listening on its port')
  }

  /** A call; one that carries answers checks the server first. */
  async post<T>(route: string, body: Record<string, unknown> = {}): Promise<T> {
    if (carriesAnswers(body)) await this.verifyServer()
    return this.send<T>(route, body)
  }

  /** An NDJSON stream; resolves when it ends (or the signal aborts it). One that carries answers checks the server first. */
  async stream(route: string, body: Record<string, unknown>, onMessage: (message: StreamMessage) => void, signal?: AbortSignal): Promise<void> {
    if (carriesAnswers(body)) await this.verifyServer()
    const response = await this.request(route, body, signal)
    if (!response.ok) throw await failure(response)
    if (!response.body) throw new ApiError(500, 'the stream has no body')
    let handlerFailed = false
    try {
      await readLines(response.body, (line) => {
        let message: StreamMessage
        try {
          message = JSON.parse(line) as StreamMessage
        } catch {
          return
        }
        if (!message || typeof message !== 'object' || typeof message.kind !== 'string') return
        try {
          onMessage(message)
        } catch (error) {
          handlerFailed = true
          throw error
        }
      })
    } catch (error) {
      // The page's own bug is not the server going away.
      if (handlerFailed || signal?.aborted) throw error
      throw this.stop('unreachable', 'the deploy UI stopped while this stream was open')
    }
  }

  private async send<T>(route: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.request(route, body)
    if (!response.ok) throw await failure(response)
    return (await response.json()) as T
  }

  /** fetch, or the page stops: a loopback server that cannot be reached has stopped. */
  private async request(route: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    if (this.gone) throw this.gone
    try {
      return await this.fetchImpl(`/api/${route}`, init(body, this.token, signal))
    } catch (error) {
      if (signal?.aborted) throw error
      throw this.stop('unreachable', 'the deploy UI is not running any more (it stopped after its idle time, from Quit, or with Ctrl-C)')
    }
  }

  private stop(why: ServerGone['why'], message: string): ServerGone {
    if (this.gone) return this.gone
    this.gone = new ServerGone(why, message)
    this.onGone?.(this.gone)
    return this.gone
  }
}
