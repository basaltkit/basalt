import { fetchWithRetry } from './http.js'
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
  /** Injected fetch. Defaults to the global `fetch`. */
  fetch?: FetchLike
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
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly name = 'openai'
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike

  constructor(options: OpenAICompatibleProviderOptions) {
    if (!options.apiKey) {
      throw new Error('OpenAICompatibleProvider: apiKey is required (set AI_API_KEY)')
    }
    this.apiKey = options.apiKey
    this.model = options.model ?? DEFAULT_MODEL
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined)
    if (!f) throw new Error('OpenAICompatibleProvider: no fetch available — pass options.fetch')
    this.fetchImpl = f
  }

  async generate(options: GenerateOptions): Promise<string> {
    const { ok, status, body } = await fetchWithRetry(this.fetchImpl, this.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
        max_tokens: options.maxTokens ?? 4096,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      }),
    })

    if (!ok) {
      const detail = safeError(body)
      throw new Error(`OpenAICompatibleProvider: ${status}${detail ? ` — ${detail}` : ''}`)
    }
    const json = JSON.parse(body) as OpenAIResponse
    return json.choices?.[0]?.message?.content ?? ''
  }

  stream(options: GenerateOptions): AsyncIterable<string> {
    return singleChunkStream(() => this.generate(options))
  }
}

function safeError(text: string): string {
  try {
    return (JSON.parse(text) as OpenAIResponse).error?.message ?? text.slice(0, 200)
  } catch {
    return text.slice(0, 200)
  }
}
