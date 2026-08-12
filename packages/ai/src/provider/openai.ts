import { fetchWithRetry } from './http.js'
import { globalSseFetch, parseSseContent, type SseFetch } from './sse.js'
import {
  singleChunkStream,
  type AIProvider,
  type FetchLike,
  type GenerateOptions,
} from './types.js'

export interface OpenAICompatibleProviderOptions {
  /** API key → `Authorization: Bearer <key>`. Required. */
  apiKey: string
  /** Model id, e.g. `'gpt-4o-mini'` or `'us.anthropic.claude-sonnet-4-5-20250929-v1:0'`. */
  model?: string
  /**
   * API base URL up to and including `/v1`. `/chat/completions` is appended.
   * Defaults to the public OpenAI API; point it at any compatible gateway, e.g.
   * `https://ai.go4ai.io/v1`.
   */
  baseUrl?: string
  /**
   * Stream the completion via SSE (default `true`). Streaming avoids the spurious
   * 500 some gateways return when buffering a long non-streaming response. Set
   * `false` for a gateway that doesn't support streaming.
   */
  stream?: boolean
  /** Injected non-streaming fetch. Defaults to the global `fetch`. */
  fetch?: FetchLike
  /** Injected streaming fetch. Defaults to one built on the global `fetch`. */
  sseFetch?: SseFetch
}

const DEFAULT_MODEL = 'gpt-4o-mini'
const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>
  error?: { message?: string }
}

/**
 * Provider for any OpenAI-compatible Chat Completions endpoint (OpenAI itself,
 * Azure-style gateways, LiteLLM, OpenRouter, go4ai, …). Unlike Anthropic's API,
 * system messages stay inline in the `messages` array.
 *
 * Streams by default — the robust path for large generations behind a gateway.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name = 'openai'
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly streaming: boolean
  private readonly fetchImpl: FetchLike
  private readonly sseFetchImpl: SseFetch

  constructor(options: OpenAICompatibleProviderOptions) {
    if (!options.apiKey) {
      throw new Error('OpenAICompatibleProvider: apiKey is required (set AI_API_KEY)')
    }
    this.apiKey = options.apiKey
    this.model = options.model ?? DEFAULT_MODEL
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.streaming = options.stream ?? true
    this.fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined) ?? missingFetch
    this.sseFetchImpl = options.sseFetch ?? globalSseFetch
  }

  async generate(options: GenerateOptions): Promise<string> {
    if (!this.streaming) return this.viaJson(options)
    let out = ''
    for await (const delta of this.viaStream(options)) out += delta
    return out
  }

  stream(options: GenerateOptions): AsyncIterable<string> {
    if (!this.streaming) return singleChunkStream(() => this.viaJson(options))
    return this.viaStream(options)
  }

  private get endpoint(): string {
    return this.baseUrl + '/chat/completions'
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` }
  }

  private requestBody(options: GenerateOptions, stream: boolean): string {
    return JSON.stringify({
      model: this.model,
      messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: options.maxTokens ?? 4096,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(stream ? { stream: true } : {}),
    })
  }

  private async *viaStream(options: GenerateOptions): AsyncIterable<string> {
    const res = await this.sseFetchImpl(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: this.requestBody(options, true),
    })
    if (!res.ok) {
      throw new Error(`OpenAICompatibleProvider: ${res.status} — ${safeError(await res.text())}`)
    }
    yield* parseSseContent(res.chunks)
  }

  private async viaJson(options: GenerateOptions): Promise<string> {
    const { ok, status, body } = await fetchWithRetry(this.fetchImpl, this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: this.requestBody(options, false),
    })
    if (!ok) {
      const detail = safeError(body)
      throw new Error(`OpenAICompatibleProvider: ${status}${detail ? ` — ${detail}` : ''}`)
    }
    return (JSON.parse(body) as OpenAIResponse).choices?.[0]?.message?.content ?? ''
  }
}

const missingFetch: FetchLike = () => {
  throw new Error('OpenAICompatibleProvider: no fetch available — pass options.fetch')
}

function safeError(text: string): string {
  try {
    return (JSON.parse(text) as OpenAIResponse).error?.message ?? text.slice(0, 200)
  } catch {
    return text.slice(0, 200)
  }
}
