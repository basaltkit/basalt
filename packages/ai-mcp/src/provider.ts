import { createProvider, providerEnvFrom, type AIProvider } from '@basaltkit/ai/workflows'

/**
 * Build an `AIProvider` from an environment record — the client-supplied `env`
 * (defaults to `process.env`). `AI_PROVIDER`/`AI_MODEL`/`AI_API_KEY`/`AI_BASE_URL`
 * select and tune the vendor.
 *
 * Keys are read here and used only in-memory to construct the provider. This
 * package never logs, persists, or echoes them.
 */
export function buildProvider(env: Record<string, string | undefined> = process.env): AIProvider {
  return createProvider(providerEnvFrom(env))
}
