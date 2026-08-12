import { describe, expect, it } from 'vitest'
import {
  AnthropicProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
  createProvider,
  type FetchLike,
} from '../src/index.js'

function fakeFetch(status: number, body: unknown): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  })
}

/** Capturing fetch: records the URL + parsed request body for assertions. */
function recordingFetch(body: unknown): FetchLike & { calls: Array<{ url: string; init: unknown }> } {
  const calls: Array<{ url: string; init: unknown }> = []
  const fn = (async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
    calls.push({ url, init: { headers: init?.headers, body: init?.body ? JSON.parse(init.body) : undefined } })
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }) as FetchLike & { calls: Array<{ url: string; init: unknown }> }
  fn.calls = calls
  return fn
}

describe('AnthropicProvider', () => {
  it('extracts text blocks from a Messages response', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      fetch: fakeFetch(200, { content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] }),
    })
    expect(await provider.generate({ messages: [{ role: 'user', content: 'hi' }] })).toBe('hello world')
  })

  it('throws with the API error message on a non-2xx', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      fetch: fakeFetch(401, { error: { message: 'invalid x-api-key' } }),
    })
    await expect(provider.generate({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /401 — invalid x-api-key/,
    )
  })

  it('requires an api key', () => {
    expect(() => new AnthropicProvider({ apiKey: '', fetch: fakeFetch(200, {}) })).toThrow(/apiKey is required/)
  })

  it('streams the completion as a single chunk', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'k',
      fetch: fakeFetch(200, { content: [{ type: 'text', text: 'chunk' }] }),
    })
    const chunks: string[] = []
    for await (const c of provider.stream({ messages: [{ role: 'user', content: 'x' }] })) chunks.push(c)
    expect(chunks).toEqual(['chunk'])
  })
})

describe('OllamaProvider', () => {
  it('reads message.content from /api/chat', async () => {
    const provider = new OllamaProvider({ fetch: fakeFetch(200, { message: { content: 'local answer' } }) })
    expect(await provider.generate({ messages: [{ role: 'user', content: 'hi' }] })).toBe('local answer')
  })
})

describe('OpenAICompatibleProvider', () => {
  it('reads choices[0].message.content and hits /chat/completions with a Bearer token', async () => {
    const fetch = recordingFetch({ choices: [{ message: { content: 'gateway answer' } }] })
    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk-test',
      model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      baseUrl: 'https://ai.go4ai.io/v1',
      fetch,
    })
    const answer = await provider.generate({
      messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }],
    })
    expect(answer).toBe('gateway answer')

    const call = fetch.calls[0]
    expect(call?.url).toBe('https://ai.go4ai.io/v1/chat/completions')
    const init = call?.init as { headers: Record<string, string>; body: { model: string; messages: unknown[] } }
    expect(init.headers['authorization']).toBe('Bearer sk-test')
    expect(init.body.model).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0')
    // system message stays inline (unlike Anthropic)
    expect(init.body.messages).toHaveLength(2)
  })

  it('surfaces the error message on a non-2xx', async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk-test',
      fetch: fakeFetch(401, { error: { message: 'invalid api key' } }),
    })
    await expect(provider.generate({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
      /401 — invalid api key/,
    )
  })

  it('requires an api key', () => {
    expect(() => new OpenAICompatibleProvider({ apiKey: '', fetch: fakeFetch(200, {}) })).toThrow(/apiKey is required/)
  })
})

describe('createProvider', () => {
  it('defaults to anthropic', () => {
    const p = createProvider({ AI_API_KEY: 'k' }, { fetch: fakeFetch(200, {}) })
    expect(p.name).toBe('anthropic')
  })

  it('selects ollama and needs no key', () => {
    const p = createProvider({ AI_PROVIDER: 'ollama' }, { fetch: fakeFetch(200, {}) })
    expect(p.name).toBe('ollama')
  })

  it('rejects an unknown provider', () => {
    expect(() => createProvider({ AI_PROVIDER: 'nope' })).toThrow(/unknown AI_PROVIDER/)
  })

  it('selects the OpenAI-compatible provider for openai', () => {
    const p = createProvider(
      { AI_PROVIDER: 'openai', AI_API_KEY: 'sk', AI_BASE_URL: 'https://ai.go4ai.io/v1' },
      { fetch: fakeFetch(200, {}) },
    )
    expect(p.name).toBe('openai')
  })

  it('reports google as not yet implemented', () => {
    expect(() => createProvider({ AI_PROVIDER: 'google' })).toThrow(/not implemented/)
  })
})
