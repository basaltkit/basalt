/**
 * I16 — an idempotent replay must never bypass the tool result's redaction.
 *
 * The idempotency stage replays the RECORDED response verbatim: a thrown
 * error's body with its unredacted `details`. A tool call therefore never
 * carries an idempotency key into the route pipeline, even when the app lists
 * the header in `forwardHeaders` — each call runs the handler and its error is
 * redacted like any other.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type BasaltApp } from '@basaltkit/core'
import { HttpError, REDACTED_DETAIL, idempotencyPlugin, route } from '@basaltkit/http'
import { collectTools } from '../src/index.js'

let calls = 0
const routes = [
  route({
    method: 'POST',
    url: '/reset',
    meta: { mcp: { name: 'reset' } },
    handler() {
      calls++
      throw new HttpError(409, 'RESET_PENDING', 'A reset is pending.', {
        details: { resetToken: 'r-secret-123', attempts: 2 },
      })
    },
  }),
]

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string => result.content[0]!.text ?? ''

let app: BasaltApp | undefined
afterEach(async () => {
  await app?.shutdown()
  app = undefined
  calls = 0
})

describe('MCP tool calls and idempotency keys (I16)', () => {
  for (const header of [undefined, 'X-Request-Key'] as const) {
    it(`never forwards the idempotency key${header ? ` (custom header ${header})` : ''}, so no replay skips redaction`, async () => {
      app = await createApp({ plugins: [idempotencyPlugin(header ? { header } : {})] }).boot()
      const name = (header ?? 'idempotency-key').toLowerCase()
      const [tool] = collectTools(routes, app.container, {
        reportError: false,
        forwardHeaders: ['idempotency-key', name],
      })
      const headers = { authorization: 'Bearer caller', [name]: 'key-1' }
      const first = await tool!.invoke({}, { headers })
      const second = await tool!.invoke({}, { headers })
      for (const result of [first, second]) {
        expect(result.isError).toBe(true)
        expect(textOf(result)).not.toContain('r-secret-123')
        expect(JSON.parse(textOf(result))).toMatchObject({ details: { resetToken: REDACTED_DETAIL, attempts: 2 } })
      }
      // Both calls ran the handler: nothing was recorded or replayed.
      expect(calls).toBe(2)
    })
  }
})
