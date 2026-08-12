import { AnthropicProvider } from './anthropic.js'
import { OllamaProvider } from './ollama.js'
import { OpenAICompatibleProvider } from './openai.js'
import type { AIProvider, FetchLike } from './types.js'

/** Providers wired in 0.1. `openai` covers any OpenAI-compatible gateway; `google` is stubbed. */
export type ProviderName = 'anthropic' | 'ollama' | 'openai' | 'openai-compatible' | 'google'

/** The subset of environment the provider layer reads. */
export interface ProviderEnv {
  AI_PROVIDER?: string
  AI_MODEL?: string
  AI_API_KEY?: string
  AI_BASE_URL?: string
  /** `'false'` disables SSE streaming for the OpenAI-compatible provider. */
  AI_STREAM?: string
}

export interface CreateProviderOptions {
  /** Override the injected fetch (tests). */
  fetch?: FetchLike
}

/** Read the provider-relevant vars off `process.env` into a typed {@link ProviderEnv}. */
export function providerEnvFromProcess(): ProviderEnv {
  const e = process.env
  return {
    ...(e.AI_PROVIDER !== undefined ? { AI_PROVIDER: e.AI_PROVIDER } : {}),
    ...(e.AI_MODEL !== undefined ? { AI_MODEL: e.AI_MODEL } : {}),
    ...(e.AI_API_KEY !== undefined ? { AI_API_KEY: e.AI_API_KEY } : {}),
    ...(e.AI_BASE_URL !== undefined ? { AI_BASE_URL: e.AI_BASE_URL } : {}),
    ...(e.AI_STREAM !== undefined ? { AI_STREAM: e.AI_STREAM } : {}),
  }
}

/**
 * Build an {@link AIProvider} from environment. `AI_PROVIDER` selects the vendor
 * (default `anthropic`); `AI_MODEL`, `AI_API_KEY`, `AI_BASE_URL` tune it.
 *
 * The read-only `ai:analyze` / `ai:doctor` commands never call this — their rules
 * are deterministic and run offline. A provider is only needed for the optional
 * `--explain` narrative and, later, for `ai:plan` / `ai:make`.
 */
export function createProvider(env: ProviderEnv = {}, options: CreateProviderOptions = {}): AIProvider {
  const name = (env.AI_PROVIDER ?? 'anthropic').toLowerCase()
  const fetchOpt = options.fetch ? { fetch: options.fetch } : {}

  switch (name) {
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: env.AI_API_KEY ?? '',
        ...(env.AI_MODEL ? { model: env.AI_MODEL } : {}),
        ...(env.AI_BASE_URL ? { baseUrl: env.AI_BASE_URL } : {}),
        ...fetchOpt,
      })
    case 'ollama':
      return new OllamaProvider({
        ...(env.AI_MODEL ? { model: env.AI_MODEL } : {}),
        ...(env.AI_BASE_URL ? { baseUrl: env.AI_BASE_URL } : {}),
        ...fetchOpt,
      })
    case 'openai':
    case 'openai-compatible':
      // Any OpenAI Chat Completions endpoint — OpenAI, LiteLLM, OpenRouter,
      // go4ai, etc. Point AI_BASE_URL at the gateway's `/v1`. Streams by default
      // (AI_STREAM=false to disable).
      return new OpenAICompatibleProvider({
        apiKey: env.AI_API_KEY ?? '',
        ...(env.AI_MODEL ? { model: env.AI_MODEL } : {}),
        ...(env.AI_BASE_URL ? { baseUrl: env.AI_BASE_URL } : {}),
        ...(env.AI_STREAM === 'false' ? { stream: false } : {}),
        ...fetchOpt,
      })
    case 'google':
      throw new Error(
        `createProvider: 'google' is not implemented in @basaltkit/ai@0.1. ` +
          `Available now: 'anthropic', 'ollama', 'openai' (OpenAI-compatible).`,
      )
    default:
      throw new Error(
        `createProvider: unknown AI_PROVIDER='${name}'. Use 'anthropic', 'ollama' or 'openai'.`,
      )
  }
}
