import { describe, expect, it } from 'vitest'
import { ctx, runWithContext, tryCtx } from '../src/index.js'

describe('context (AsyncLocalStorage)', () => {
  it('ctx() throws a typed error outside of a context', () => {
    expect(tryCtx()).toBeUndefined()
    try {
      ctx()
      expect.unreachable()
    } catch (error) {
      expect((error as { code: string }).code).toBe('CONTEXT_UNAVAILABLE')
    }
  })

  it('propagates the context across awaits and nested functions', async () => {
    async function deepService(): Promise<string> {
      await Promise.resolve()
      return ctx().requestId as string
    }

    const result = await runWithContext({ requestId: 'req-1' }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      return deepService()
    })
    expect(result).toBe('req-1')
  })

  it('concurrent contexts do not leak into each other', async () => {
    const results = await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        runWithContext({ requestId: id }, async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 5))
          return ctx().requestId
        }),
      ),
    )
    expect(results).toEqual(['a', 'b', 'c'])
  })
})
