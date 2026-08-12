import {
  singleChunkStream,
  type AIProvider,
  type FetchLike,
  type GenerateOptions,
} from './types.js'

export interface OllamaProviderOptions {
  /** Model id, e.g. `'llama3.1'`. */
  model?: string
  /** Ollama base URL. Defaults to the local daemon. */
  baseUrl?: string
  /** Injected fetch. Defaults to the global `fetch`. */
  fetch?: FetchLike
}

const DEFAULT_MODEL = 'llama3.1'

interface OllamaResponse {
  message?: { content?: string }
  error?: string
}

/**
 * Local Ollama provider (`/api/chat`, `stream: false`). Needs no API key, so it's
 * the zero-cost default for offline development and CI.
 */
export class OllamaProvider implements AIProvider {
  readonly name = 'ollama'
  readonly model: string
  private readonly baseUrl: string
  private readonly fetchImpl: FetchLike

  constructor(options: OllamaProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL
    this.baseUrl = (options.baseUrl ?? 'http://localhost:11434').replace(/\/$/, '')
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined)
    if (!f) throw new Error('OllamaProvider: no fetch available — pass options.fetch')
    this.fetchImpl = f
  }

  async generate(options: GenerateOptions): Promise<string> {
    const res = await this.fetchImpl(this.baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: options.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(options.temperature !== undefined ? { options: { temperature: options.temperature } } : {}),
      }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`OllamaProvider: ${res.status} — ${text.slice(0, 200)}`)
    const json = JSON.parse(text) as OllamaResponse
    if (json.error) throw new Error(`OllamaProvider: ${json.error}`)
    return json.message?.content ?? ''
  }

  stream(options: GenerateOptions): AsyncIterable<string> {
    return singleChunkStream(() => this.generate(options))
  }
}
