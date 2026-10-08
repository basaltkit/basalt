import { describe, expect, it, vi } from 'vitest'
import { RPC_ERRORS } from '@basaltkit/mcp-core'
import { fixtureServer } from './fixture.js'

describe('internal errors', () => {
  it('answers a generic "Internal error" and forwards the cause to onError', async () => {
    const onError = vi.fn()
    const server = fixtureServer({
      onError,
      createReader: () => {
        throw new Error('EACCES: /home/dev/.secret')
      },
    })
    const res = await server.handleMessage({
      jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'basalt://project/context' },
    })
    expect(res?.error).toEqual({ code: RPC_ERRORS.INTERNAL_ERROR, message: 'Internal error' })
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]![0] as Error).message).toContain('.secret')
  })

  it('rejects non-string prompt arguments with INVALID_PARAMS', async () => {
    const res = await fixtureServer().handleMessage({
      jsonrpc: '2.0', id: 1, method: 'prompts/get', params: { name: 'plan-feature', arguments: { request: 42 } },
    })
    expect(res?.error?.code).toBe(RPC_ERRORS.INVALID_PARAMS)
  })
})
