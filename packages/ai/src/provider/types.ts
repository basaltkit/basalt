/**
 * Provider-agnostic AI surface.
 *
 * The agent never talks to a vendor SDK directly — every piece of it depends on
 * this interface. Swapping Anthropic ↔ Ollama ↔ an OpenAI-compatible endpoint is
 * therefore an `AI_PROVIDER` config change, not a code change (spec §17).
 */
export interface AIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface GenerateOptions {
  messages: AIMessage[]
  /** Sampling temperature (0 = deterministic). */
  temperature?: number
  /** Hard cap on output tokens. */
  maxTokens?: number
  /** Abort the in-flight request. Providers forward it to the underlying fetch. */
  signal?: AbortSignal
}

export interface AIProvider {
  /** Stable id, e.g. `'anthropic'`. */
  readonly name: string
  /** Concrete model id in use, e.g. `'claude-sonnet-5'`. */
  readonly model: string
  /** One-shot completion — returns the assistant's full text. */
  generate(options: GenerateOptions): Promise<string>
  /** Streaming completion — yields chunks as they arrive. */
  stream(options: GenerateOptions): AsyncIterable<string>
}

/**
 * Minimal fetch surface — the global `fetch` (Node 18+) is assignable, and it's
 * injectable so providers can be unit-tested without a network. Mirrors the shape
 * used by `@basaltkit/search-elasticsearch` to avoid a DOM lib dependency.
 */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/**
 * Default `stream()` implementation for providers without real token streaming
 * yet: run the one-shot completion and yield it as a single chunk. Real
 * server-sent-event streaming lands in a later phase; this keeps the
 * {@link AIProvider} contract honest today.
 */
export async function* singleChunkStream(run: () => Promise<string>): AsyncIterable<string> {
  yield await run()
}
