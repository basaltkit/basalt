import { describe, expect, it } from 'vitest'
import { toGoogleError } from '../src/errors.js'

// The adapters do not depend on @basaltkit/http; read the channel the way its
// `internalDetailsOf` does, and "the response" as what it serialises: code,
// message and details.
const internalDetailsOf = (error: unknown): unknown => (error as { internalDetails?: unknown }).internalDetails
const toErrorResponse = (error: unknown) => {
  const e = error as { code: string; message: string; details?: unknown }
  return { code: e.code, message: e.message, details: e.details, enumerable: { ...(error as object) } }
}


const CONTEXT = { provider: 'google', connectionId: 'c1' }

describe('Google provider message', () => {
  it('carries error.message on the internal channel only', () => {
    const body = JSON.stringify({
      error: {
        code: 403,
        message: 'Request had insufficient authentication scopes.',
        errors: [{ reason: 'insufficientPermissions', domain: 'global', message: 'x' }],
      },
    })
    const error = toGoogleError(403, body, CONTEXT)
    expect(error).toMatchObject({ code: 'DRIVE_ACCESS_DENIED', details: { reason: 'insufficientPermissions' } })
    expect(internalDetailsOf(error)).toEqual({ providerMessage: 'Request had insufficient authentication scopes.' })
    expect(JSON.stringify(toErrorResponse(error))).not.toContain('authentication scopes')
  })

  it('reads the OAuth error_description', () => {
    const error = toGoogleError(401, JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }), CONTEXT)
    expect(internalDetailsOf(error)).toEqual({ providerMessage: 'Token has been expired or revoked.' })
  })

  it('never carries a non-JSON body', () => {
    expect(internalDetailsOf(toGoogleError(500, '<html>Bad gateway</html>', CONTEXT))).toBeUndefined()
  })
})
