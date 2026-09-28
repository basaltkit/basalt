import { fail, RPC_ERRORS, type JsonRpcRequest, type JsonRpcResponse } from './protocol.js'
import type { CallContext } from './server.js'
import type { StdioServerLike } from './stdio.js'

/**
 * Dispatch one decoded JSON-RPC payload — a single message or a batch — to a
 * server. A batch (a JSON array, required by protocol revision 2025-03-26) is
 * answered with an array holding one response per request, in any order;
 * notifications contribute nothing, and a batch of only notifications is
 * answered with `null` (no reply), exactly like a single notification. An empty
 * array is an invalid request. `initialize` must not be batched (spec), so it is
 * rejected inside a batch.
 *
 * Every transport (stdio, `serveHttp`, the runtime `/mcp` route) goes through
 * this, so batching behaves the same everywhere.
 */
export async function dispatchPayload(
  server: StdioServerLike,
  payload: unknown,
  ctx: CallContext = {},
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (!Array.isArray(payload)) return server.handleMessage(payload as JsonRpcRequest, ctx)
  if (payload.length === 0) {
    return fail(null, RPC_ERRORS.INVALID_REQUEST, 'Invalid JSON-RPC request: empty batch')
  }
  const responses = await Promise.all(
    payload.map((message: unknown) => {
      const m = message as Partial<JsonRpcRequest> | null
      if (m && typeof m === 'object' && m.method === 'initialize') {
        return m.id === undefined
          ? null
          : fail(m.id ?? null, RPC_ERRORS.INVALID_REQUEST, 'initialize must not be part of a batch')
      }
      return server.handleMessage(message as JsonRpcRequest, ctx)
    }),
  )
  const answered = responses.filter((r): r is JsonRpcResponse => r !== null)
  return answered.length > 0 ? answered : null
}
