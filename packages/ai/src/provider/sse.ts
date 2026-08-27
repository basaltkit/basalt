/**
 * Minimal Server-Sent-Events support for OpenAI-compatible streaming.
 *
 * Some gateways (e.g. go4ai) return a spurious 500 when they buffer a long
 * non-streaming completion, even though the model generated it (and charged for
 * it). Streaming sidesteps that: the response is delivered in chunks, so there's
 * no large buffered body to choke on.
 */

export interface SseResponse {
  ok: boolean
  status: number
  /** Full body — used for the error message on a non-2xx. */
  text(): Promise<string>
  /** Decoded text pieces of the streaming body. */
  chunks: AsyncIterable<string>
}

export type SseFetch = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<SseResponse>

/** Default {@link SseFetch} backed by the global `fetch` + its streaming body. */
export const globalSseFetch: SseFetch = async (url, init) => {
  const f = (globalThis as { fetch?: (u: string, i?: unknown) => Promise<unknown> }).fetch
  if (!f) throw new Error('globalSseFetch: no global fetch available')
  const res = (await f(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    ...(init.signal ? { signal: init.signal } : {}),
  })) as { ok: boolean; status: number; text(): Promise<string>; body: unknown }

  const stream = res.body as AsyncIterable<Uint8Array> | null
  const decoder = new TextDecoder()
  async function* chunks(): AsyncIterable<string> {
    if (!stream) return
    for await (const part of stream) yield decoder.decode(part, { stream: true })
  }
  return { ok: res.ok, status: res.status, text: () => res.text(), chunks: chunks() }
}

/**
 * Parse an OpenAI-style SSE stream, yielding each `choices[0].delta.content`
 * piece. Tolerant of keep-alive lines, partial frames and the `[DONE]` sentinel.
 */
export async function* parseSseContent(chunks: AsyncIterable<string>): AsyncIterable<string> {
  let buffer = ''
  for await (const chunk of chunks) {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '' || payload === '[DONE]') continue
      try {
        const delta = (JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]
          ?.delta?.content
        if (delta) yield delta
      } catch {
        // keep-alive or split frame — ignore and continue
      }
    }
  }
}
