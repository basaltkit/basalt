import { StringDecoder } from 'node:string_decoder'
import { fail, RPC_ERRORS, type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse } from './protocol.js'
import type { CallContext } from './server.js'
import { dispatchPayload } from './dispatch.js'

/** The minimal server surface the stdio loop drives — {@link McpServer} satisfies it. */
export interface StdioServerLike {
  handleMessage(message: JsonRpcRequest, ctx?: CallContext): Promise<JsonRpcResponse | null>
}

/** Default cap on one newline-delimited message: 4 MiB worth of characters. */
export const DEFAULT_MAX_LINE_LENGTH = 4 * 1024 * 1024

/** Default cap on requests in flight at once on one stdio connection. */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 16

export interface ServeStdioOptions {
  /** Static headers applied to every tool call — stdio has no per-request headers. */
  headers?: Record<string, string>
  /** Defaults to `process.stdin`. */
  input?: NodeJS.ReadableStream
  /** Defaults to `process.stdout`. */
  output?: { write(chunk: string): unknown }
  /**
   * Longest accepted line (one JSON-RPC message), in characters. A longer line
   * is discarded up to its newline — never buffered whole — and answered with
   * an `INVALID_REQUEST` error. Default {@link DEFAULT_MAX_LINE_LENGTH} (4 MiB).
   */
  maxLineLength?: number
  /**
   * Most requests (messages with an `id`) this connection may have in flight
   * at once. One more is answered immediately with a `SERVER_BUSY` (-32000)
   * JSON-RPC error instead of starting — the stream is a single client, but
   * nothing else bounds how many tool calls it can pile up. Notifications
   * (e.g. `notifications/cancelled`) are never counted nor refused.
   * Default {@link DEFAULT_MAX_CONCURRENT_REQUESTS} (16).
   */
  maxConcurrentRequests?: number
}

/** A running stdio server. `close()` detaches the stdin listener. */
export interface StdioHandle {
  close(): void
}

/** The fixed form a yes/no elicitation asks the client to render. */
const CONFIRM_SCHEMA = {
  type: 'object',
  properties: { confirm: { type: 'boolean', title: 'Confirm' } },
  required: ['confirm'],
} as const

/**
 * The id of a message that is a request (it will be answered), or `undefined`
 * for a notification or anything the dispatcher will reject without running.
 */
function requestId(message: unknown): JsonRpcId | undefined {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return undefined
  const m = message as Record<string, unknown>
  if (typeof m['method'] !== 'string' || !('id' in m) || m['id'] === undefined) return undefined
  const id = m['id']
  // A malformed id still takes a slot: the dispatcher answers it (with an error).
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

function isResponse(message: unknown): message is JsonRpcResponse {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return false
  const m = message as Record<string, unknown>
  return m['method'] === undefined && m['id'] !== undefined && ('result' in m || 'error' in m)
}

/** True when an `initialize` request announces the client's `elicitation` capability. */
function announcesElicitation(message: unknown): boolean | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const m = message as { method?: unknown; params?: { capabilities?: { elicitation?: unknown } } }
  if (m.method !== 'initialize') return undefined
  const cap = m.params?.capabilities?.elicitation
  return cap !== undefined && cap !== null && cap !== false
}

/**
 * Serve MCP over stdio — newline-delimited JSON-RPC on stdin/stdout, the
 * transport local agents (Claude Desktop, IDEs) speak. Pure Node streams; no SDK.
 *
 * - The byte stream is decoded with a `StringDecoder`, so a multibyte character
 *   split across two chunks is reassembled, never turned into U+FFFD.
 * - A line longer than `maxLineLength` is dropped (with an error reply) instead
 *   of growing the buffer without bound.
 * - JSON-RPC batches (arrays) are accepted, as protocol revision 2025-03-26 requires.
 * - The transport supplies a `notify` callback so the dispatcher can push
 *   server→client notifications (progress) back on the same stream.
 * - When the client announced the `elicitation` capability in `initialize`,
 *   tools receive an `elicit(prompt)` that sends an `elicitation/create`
 *   request and resolves `true` only when the user accepted with `confirm: true`.
 *   Without the capability, `elicit` is absent — callers that need a
 *   confirmation must fail closed.
 * - Each stream is its own session: a `notifications/cancelled` arriving here
 *   only reaches calls started on this stream.
 */
export function serveStdio(server: StdioServerLike, options: ServeStdioOptions = {}): StdioHandle {
  const input: NodeJS.ReadableStream = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const headers = options.headers ?? {}
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH
  const maxConcurrent = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS
  let inFlight = 0 // requests admitted and not yet answered
  const session = {} // identity of this connection — scopes cancellation
  const decoder = new StringDecoder('utf8')

  let buffer = ''
  let discarding = false // inside an over-long line, dropping until its newline
  let clientCanElicit = false
  let elicitSeq = 0
  let closed = false
  const pending = new Map<JsonRpcId, (response: JsonRpcResponse) => void>()

  const emit = (line: string): void => {
    output.write(`${line}\n`)
  }
  const notify = (message: JsonRpcRequest): void => emit(JSON.stringify(message))
  const tooLong = (): void =>
    emit(JSON.stringify(fail(null, RPC_ERRORS.INVALID_REQUEST, `Message exceeds the maximum line length (${maxLineLength})`)))

  const elicit = (prompt: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (closed) return resolve(false)
      const id = `basalt-elicit-${++elicitSeq}`
      pending.set(id, (response) => {
        const result = response.result as { action?: unknown; content?: { confirm?: unknown } } | undefined
        resolve(response.error === undefined && result?.action === 'accept' && result.content?.confirm === true)
      })
      notify({
        jsonrpc: '2.0',
        id,
        method: 'elicitation/create',
        params: { message: prompt, requestedSchema: CONFIRM_SCHEMA },
      })
    })

  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (discarding) {
        discarding = false // the tail of an over-long line — already answered
        continue
      }
      if (line.length > maxLineLength) {
        tooLong()
        continue
      }
      const trimmed = line.trim()
      if (!trimmed) continue
      void handleLine(trimmed)
    }
    if (discarding) {
      buffer = ''
    } else if (buffer.length > maxLineLength) {
      buffer = ''
      discarding = true
      tooLong()
    }
  }

  const handleLine = async (line: string): Promise<void> => {
    let payload: unknown
    try {
      payload = JSON.parse(line)
    } catch {
      emit(JSON.stringify(fail(null, RPC_ERRORS.PARSE_ERROR, 'Parse error')))
      return
    }
    // Client responses answer our own requests (elicitation) — route, never reply.
    const messages = Array.isArray(payload) ? payload : [payload]
    const requests: unknown[] = []
    for (const message of messages) {
      if (isResponse(message)) {
        const settle = pending.get(message.id)
        if (settle) {
          pending.delete(message.id)
          settle(message)
        }
        continue
      }
      // `initialize` is only valid unbatched (a batched one is rejected by the dispatcher).
      const elicitation = Array.isArray(payload) ? undefined : announcesElicitation(message)
      if (elicitation !== undefined) clientCanElicit = elicitation
      requests.push(message)
    }
    if (messages.length > 0 && requests.length === 0) return
    // Admission control: every request (it carries an `id`) takes a slot until
    // it is answered; past the cap it is refused on the spot. Notifications
    // pass freely — a cancel must always get through to a saturated connection.
    const admitted: unknown[] = []
    const refused: JsonRpcResponse[] = []
    for (const message of requests) {
      const id = requestId(message)
      if (id === undefined) {
        admitted.push(message)
      } else if (inFlight < maxConcurrent) {
        inFlight++
        admitted.push(message)
      } else {
        refused.push(
          fail(id, RPC_ERRORS.SERVER_BUSY, `Too many requests in flight (max ${maxConcurrent}); retry later`),
        )
      }
    }
    const slots = admitted.length - admitted.filter((message) => requestId(message) === undefined).length
    let response: JsonRpcResponse | JsonRpcResponse[] | null = null
    try {
      if (admitted.length > 0) {
        const ctx: CallContext = { headers, notify, session, ...(clientCanElicit ? { elicit } : {}) }
        response = await dispatchPayload(server, Array.isArray(payload) ? admitted : admitted[0], ctx)
      }
    } finally {
      inFlight -= slots
    }
    if (!Array.isArray(payload)) {
      const single = refused[0] ?? response
      if (single !== null) emit(JSON.stringify(single))
      return
    }
    const answers = [...(Array.isArray(response) ? response : response ? [response] : []), ...refused]
    if (answers.length > 0) emit(JSON.stringify(answers))
  }

  input.on('data', onData)
  return {
    close: () => {
      closed = true
      input.off('data', onData)
      // An unanswered confirmation is a refusal — never leave a tool waiting.
      for (const settle of pending.values()) settle({ jsonrpc: '2.0', id: null, error: { code: RPC_ERRORS.INTERNAL_ERROR, message: 'closed' } })
      pending.clear()
    },
  }
}
