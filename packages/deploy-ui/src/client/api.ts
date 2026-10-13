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

/** The launch code for a session token, once. */
export async function exchange(code: string, fetchImpl: Fetch): Promise<string> {
  const response = await fetchImpl('/api/session', init({ code }, undefined))
  if (!response.ok) throw await failure(response)
  const body = (await response.json()) as { token?: unknown }
  if (typeof body.token !== 'string') throw new ApiError(500, 'no token in the session reply')
  return body.token
}

export class Api {
  constructor(private readonly token: string, private readonly fetchImpl: Fetch) {}

  async post<T>(route: string, body: Record<string, unknown> = {}): Promise<T> {
    const response = await this.fetchImpl(`/api/${route}`, init(body, this.token))
    if (!response.ok) throw await failure(response)
    return (await response.json()) as T
  }

  /** An NDJSON stream; resolves when it ends (or the signal aborts it). */
  async stream(route: string, body: Record<string, unknown>, onMessage: (message: StreamMessage) => void, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(`/api/${route}`, init(body, this.token, signal))
    if (!response.ok) throw await failure(response)
    if (!response.body) throw new ApiError(500, 'the stream has no body')
    await readLines(response.body, (line) => {
      let message: StreamMessage
      try {
        message = JSON.parse(line) as StreamMessage
      } catch {
        return
      }
      if (message && typeof message === 'object' && typeof message.kind === 'string') onMessage(message)
    })
  }
}
