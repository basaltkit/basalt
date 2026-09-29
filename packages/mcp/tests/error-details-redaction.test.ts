/**
 * FA-H05 / BK-050 — what an LLM client sees when a tool fails.
 *
 * A thrown error's `details` reach the model verbatim in the `isError` tool
 * result, so they are redacted by default (keys that name a secret), the
 * redactor is pluggable per plugin and per route, and `internalDetails` never
 * enter a tool result — they go to the error reporter only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, type BasaltApp } from '@basaltkit/core'
import { HttpError, REDACTED_DETAIL, route, type ErrorDetailsRedactor, type HttpErrorReport } from '@basaltkit/http'
import { MCP, McpServer, collectTools, mcpPlugin } from '../src/index.js'

const failing = (url: string, meta: Record<string, unknown> = {}) =>
  route({
    method: 'POST',
    url,
    meta: { mcp: meta },
    handler() {
      throw new HttpError(409, 'RESET_PENDING', 'A reset is pending.', {
        details: { resetToken: 'r-secret-123', password: 'hunter2', attempts: 2, mfaRequired: true },
        internalDetails: { upstream: 'idp', reply: 'account 991 frozen' },
      })
    },
  })

const routes = [
  failing('/default', { name: 'default_tool' }),
  failing('/verbatim', { name: 'verbatim_tool', redactErrorDetails: false }),
  failing('/custom', { name: 'custom_tool', redactErrorDetails: () => ({ onlyThis: 1 }) }),
]

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string => result.content[0]!.text ?? ''
const errorOf = (result: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(textOf(result)) as { code: string; message: string; details?: Record<string, unknown> }

let app: BasaltApp
beforeAll(async () => {
  app = await createApp({ plugins: [] }).boot()
})
afterAll(() => app.shutdown())

describe('MCP tool results — error details (FA-H05)', () => {
  it('redacts token/password-like details by default, keeping the rest', async () => {
    const reports: HttpErrorReport[] = []
    const [tool] = collectTools(routes, app.container, { reportError: (r) => reports.push(r) })
    const result = await tool!.invoke({})
    expect(result.isError).toBe(true)
    expect(errorOf(result)).toEqual({
      code: 'RESET_PENDING',
      message: 'A reset is pending.',
      details: { resetToken: REDACTED_DETAIL, password: REDACTED_DETAIL, attempts: 2, mfaRequired: true },
    })
    expect(textOf(result)).not.toContain('r-secret-123')
    expect(textOf(result)).not.toContain('hunter2')
  })

  it('never puts internalDetails in a tool result, but hands them to the reporter', async () => {
    const reports: HttpErrorReport[] = []
    const tools = collectTools(routes, app.container, { reportError: (r) => reports.push(r) })
    for (const tool of tools) expect(textOf(await tool.invoke({}))).not.toContain('frozen')
    expect(reports).toHaveLength(3)
    expect(reports[0]).toMatchObject({ status: 409, code: 'RESET_PENDING', method: 'POST', url: '/default' })
    expect((reports[0]!.error as HttpError).internalDetails).toEqual({ upstream: 'idp', reply: 'account 991 frozen' })
  })

  it('reports to the console by default, and not at all with reportError: false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await collectTools(routes, app.container)[0]!.invoke({})
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]![1]).toMatchObject({ internalDetails: { upstream: 'idp' } })
      warn.mockClear()
      await collectTools(routes, app.container, { reportError: false })[0]!.invoke({})
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('honours a plugin-level redactor, handing it the error, status and code', async () => {
    const redact = vi.fn<ErrorDetailsRedactor>((details) => ({ attempts: details['attempts'] }))
    const server = new McpServer({ routes, container: app.container, redactErrorDetails: redact, reportError: false })
    const result = await server.callTool('default_tool', {})
    expect(errorOf(result).details).toEqual({ attempts: 2 })
    expect(redact.mock.calls[0]![1]).toMatchObject({ status: 409, code: 'RESET_PENDING' })
  })

  it('lets a route override the redactor with meta.mcp.redactErrorDetails (false = verbatim)', async () => {
    const tools = collectTools(routes, app.container, { reportError: false })
    expect(errorOf(await tools[1]!.invoke({})).details).toMatchObject({ resetToken: 'r-secret-123' })
    expect(errorOf(await tools[2]!.invoke({})).details).toEqual({ onlyThis: 1 })
  })

  it('threads the options through mcpPlugin', async () => {
    const booted = await createApp({
      plugins: [mcpPlugin({ routes, redactErrorDetails: false, reportError: false })],
    }).boot()
    try {
      const result = await booted.container.get(MCP).callTool('default_tool', {})
      expect(errorOf(result).details).toMatchObject({ password: 'hunter2' })
    } finally {
      await booted.shutdown()
    }
  })
})
