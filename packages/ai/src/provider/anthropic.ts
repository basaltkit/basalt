import {
  singleChunkStream,
  type AIProvider,
  type FetchLike,
  type GenerateOptions,
} from './types.js'

export interface AnthropicProviderOptions {
  /** API key → `x-api-key` header. Required. */
  apiKey: string
  /** Model id. Defaults to a current Claude model. */
  model?: string
  /** API base URL. Defaults to the public Anthropic API. */
  baseUrl?: string
  /** Injected fetch. Defaults to the global `fetch`. */
  fetch?: FetchLike
}

const DEFAULT_MODEL = 'claude-sonnet-5'
const API_VERSION = '2023-06-01'

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>
  error?: { message?: string }
}

/**
 * Anthropic Messages API provider — REST directly, no SDK (same approach as the
 * Elasticsearch driver). System messages are hoisted into the top-level `system`
 * field, as the API requires.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic'
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) {
      throw new Error('AnthropicProvider: apiKey is required (set AI_API_KEY)')
    }
    this.apiKey = options.apiKey
    this.model = options.model ?? DEFAULT_MODEL
    this.baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined)
    if (!f) throw new Error('AnthropicProvider: no fetch available — pass options.fetch')
    this.fetchImpl = f
  }

  async generate(options: GenerateOptions): Promise<string> {
    const system = options.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const messages = options.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }))

    const res = await this.fetchImpl(this.baseUrl + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options.maxTokens ?? 4096,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(system ? { system } : {}),
        messages,
      }),
    })

    const text = await res.text()
    if (!res.ok) {
      const detail = safeError(text)
      throw new Error(`AnthropicProvider: ${res.status}${detail ? ` — ${detail}` : ''}`)
    }
    const json = JSON.parse(text) as AnthropicResponse
    return (json.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
  }

  stream(options: GenerateOptions): AsyncIterable<string> {
    return singleChunkStream(() => this.generate(options))
  }
}

function safeError(text: string): string {
  try {
    return (JSON.parse(text) as AnthropicResponse).error?.message ?? text.slice(0, 200)
  } catch {
    return text.slice(0, 200)
  }
}
