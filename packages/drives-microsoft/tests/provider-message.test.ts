import { describe, expect, it } from 'vitest'
import { toGraphError } from '../src/index.js'

// The adapters do not depend on @basaltkit/http; read the channel the way its
// `internalDetailsOf` does, and "the response" as what it serialises: code,
// message and details.
const internalDetailsOf = (error: unknown): unknown => (error as { internalDetails?: unknown }).internalDetails
const toErrorResponse = (error: unknown) => {
  const e = error as { code: string; message: string; details?: unknown }
  return { code: e.code, message: e.message, details: e.details, enumerable: { ...(error as object) } }
}


const context = { provider: 'microsoft', connectionId: 'conn-1' }

describe('Graph provider message', () => {
  it('carries error.message internally, redacting a quoted pre-signed URL', () => {
    const body = JSON.stringify({
      error: {
        code: 'accessDenied',
        message: 'Access denied for https://contoso.sharepoint.com/download.aspx?tempauth=eyJ0eXAi.abc.def — check Sites.Read.All',
      },
    })
    const error = toGraphError(403, body, context)
    expect(error).toMatchObject({ code: 'DRIVE_ACCESS_DENIED', details: { reason: 'accessDenied' } })
    const internal = internalDetailsOf(error) as { providerMessage: string }
    expect(internal.providerMessage).toContain('Sites.Read.All')
    expect(internal.providerMessage).toContain('[url]')
    expect(internal.providerMessage).not.toContain('tempauth')
    expect(JSON.stringify(toErrorResponse(error))).not.toContain('Sites.Read.All')
  })

  it('attaches it to a retryable 5xx as well', () => {
    const error = toGraphError(503, JSON.stringify({ error: { code: 'serviceNotAvailable', message: 'Try later.' } }), context)
    expect(internalDetailsOf(error)).toEqual({ providerMessage: 'Try later.' })
  })
})
