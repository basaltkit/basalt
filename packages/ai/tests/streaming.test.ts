import { describe, expect, it } from 'vitest'
import {
  createPlan,
  detectProject,
  fetchWithRetry,
  memoryReader,
  reviewImplementation,
  type AIProvider,
  type GenerateOptions,
  type MakeResult,
  type WorkflowProgress,
} from '../src/index.js'

const ctx = detectProject(
  '/p',
  memoryReader({
    'package.json': JSON.stringify({ dependencies: { '@basaltkit/prisma': '^1' } }),
    'src/app.ts': 'createApp({ plugins: [ prismaPlugin({}), fastifyPlugin({}) ] })',
    'prisma/schema.prisma': 'datasource db { provider = "postgresql" url = env("X") }\nmodel Tenant { id String @id }',
  }),
)

const PLAN_JSON = '{"summary":"x","entities":[{"name":"Patient","fields":[],"tenantScoped":true}]}'

/** A mock provider whose stream yields the given chunks (honouring an abort signal). */
function streamingProvider(chunks: string[]): AIProvider {
  return {
    name: 'mock',
    model: 'mock-1',
    async generate() {
      return chunks.join('')
    },
    async *stream(options: GenerateOptions) {
      for (const chunk of chunks) {
        if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        yield chunk
      }
    },
  }
}

describe('createPlan — streaming & progress', () => {
  it('emits progress from streamed chunks and returns the assembled plan', async () => {
    const chunks = [PLAN_JSON.slice(0, 20), PLAN_JSON.slice(20, 45), PLAN_JSON.slice(45)]
    const events: WorkflowProgress[] = []
    const plan = await createPlan(streamingProvider(chunks), ctx, 'req', {
      onProgress: (p) => events.push(p),
    })
    expect(events).toHaveLength(3)
    expect(events.at(-1)?.text).toBe(PLAN_JSON)
    expect(events[0]?.chunk).toBe(chunks[0])
    expect(plan.entities[0]?.name).toBe('Patient')
  })

  it('uses the one-shot generate() path (not stream) when no onProgress is given', async () => {
    let generateCalled = false
    let streamCalled = false
    const provider: AIProvider = {
      name: 'mock',
      model: 'mock-1',
      async generate() {
        generateCalled = true
        return PLAN_JSON
      },
      async *stream() {
        streamCalled = true
        yield PLAN_JSON
      },
    }
    await createPlan(provider, ctx, 'req')
    expect(generateCalled).toBe(true)
    expect(streamCalled).toBe(false)
  })

  it('threads the signal into provider.generate', async () => {
    let seen: AbortSignal | undefined
    const controller = new AbortController()
    const provider: AIProvider = {
      name: 'mock',
      model: 'mock-1',
      async generate(options: GenerateOptions) {
        seen = options.signal
        return PLAN_JSON
      },
      async *stream() {
        yield PLAN_JSON
      },
    }
    await createPlan(provider, ctx, 'req', { signal: controller.signal })
    expect(seen).toBe(controller.signal)
  })
})

describe('createPlan — cancellation', () => {
  it('rejects promptly when the signal aborts mid-generation', async () => {
    const controller = new AbortController()
    const hanging: AIProvider = {
      name: 'mock',
      model: 'mock-1',
      async generate() {
        return new Promise<string>(() => {}) // never resolves
      },
      async *stream() {
        yield '{'
        await new Promise<void>(() => {}) // hang after the first chunk
      },
    }
    const pending = createPlan(hanging, ctx, 'req', { signal: controller.signal, onProgress: () => {} })
    controller.abort()
    await expect(pending).rejects.toThrow(/aborted/i)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      createPlan(streamingProvider([PLAN_JSON]), ctx, 'req', { signal: controller.signal }),
    ).rejects.toThrow(/aborted/i)
  })
})

describe('reviewImplementation — streaming & progress', () => {
  const makeResult: MakeResult = {
    schemaVersion: 1,
    request: 'r',
    dryRun: true,
    resources: [],
    followUps: [],
    review: { items: [], ok: true },
  }
  const plan = {
    request: 'r',
    summary: 's',
    entities: [{ name: 'Patient', fields: [], tenantScoped: true }],
    steps: [],
    permissions: [],
    auditEvents: [],
    tenantScoped: true,
    warnings: [],
  }

  it('streams the verdict and emits progress', async () => {
    const events: WorkflowProgress[] = []
    const verdict = await reviewImplementation(
      streamingProvider(['{"summary":"ok",', '"issues":[]}']),
      plan,
      makeResult,
      { onProgress: (p) => events.push(p) },
    )
    expect(verdict.approved).toBe(true)
    expect(events.length).toBeGreaterThan(0)
  })
})

describe('fetchWithRetry — abort', () => {
  it('throws before calling fetch when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let called = false
    const fetchImpl = async () => {
      called = true
      return { ok: true, status: 200, text: async () => '' }
    }
    await expect(fetchWithRetry(fetchImpl, 'http://x', { method: 'GET', signal: controller.signal })).rejects.toThrow(
      /aborted/i,
    )
    expect(called).toBe(false)
  })

  it('does not retry an aborted request', async () => {
    const controller = new AbortController()
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      controller.abort()
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    await expect(fetchWithRetry(fetchImpl, 'http://x', { method: 'GET', signal: controller.signal })).rejects.toThrow(
      /aborted/i,
    )
    expect(calls).toBe(1) // no retry after an abort
  })
})
