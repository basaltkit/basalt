import type { McpToolResult, ProgressUpdate, ToolInvokeContext } from '@basaltkit/mcp-core'
import type { WorkflowProgress } from '@basaltkit/ai/workflows'

/** A failed tool result — the error travels in `content`, not as a protocol error. */
export function toolError(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** True when an error came from a cancelled (aborted) operation. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * A guidance message for when the provider can't be built (no key / bad config).
 * Never includes any secret — only the config knobs to set.
 */
export function providerHelp(error: unknown, tool: string): string {
  const detail = error instanceof Error ? error.message : String(error)
  return (
    `${tool} needs an AI provider — ${detail}. ` +
    'Set AI_API_KEY (AI_PROVIDER=anthropic, the default), point AI_BASE_URL at an ' +
    'OpenAI-compatible gateway (AI_PROVIDER=openai), or run Ollama locally (AI_PROVIDER=ollama).'
  )
}

/** Bridge a workflow progress event onto an MCP progress update. */
export function forwardProgress(ctx: ToolInvokeContext, fallback: string): (p: WorkflowProgress) => void {
  return (p) => {
    const update: ProgressUpdate = { message: p.message ?? fallback }
    if (p.text !== undefined) update.progress = p.text.length
    ctx.progress?.(update)
  }
}
