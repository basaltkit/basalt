import { describe, expect, it } from 'vitest'
import { providerMessage, toDropboxError } from '../src/errors.js'

// The adapters do not depend on @basaltkit/http; read the channel the way its
// `internalDetailsOf` does, and "the response" as what it serialises: code,
// message and details.
const internalDetailsOf = (error: unknown): unknown => (error as { internalDetails?: unknown }).internalDetails
const toErrorResponse = (error: unknown) => {
  const e = error as { code: string; message: string; details?: unknown }
  return { code: e.code, message: e.message, details: e.details, enumerable: { ...(error as object) } }
}


const context = { provider: 'dropbox', connectionId: 'conn-1' }

// The real answer Dropbox gives an app registered without the scope (BK-040).
const MISSING_SCOPE_TEXT =
  'Error in call to API function "files/list_folder": Your app (ID: 123) is not permitted to access this ' +
  'endpoint because it does not have the required scope \'files.metadata.read\'. The owner of the app can ' +
  'enable the scope for the app using the Permissions tab on the App Console.'

describe('Dropbox provider message', () => {
  it('keeps a plain-text 400 body on the internal channel, never in the response', () => {
    const error = toDropboxError(400, MISSING_SCOPE_TEXT, { ...context, contentType: 'text/plain; charset=utf-8' })
    expect(error).toMatchObject({ code: 'DRIVE_PROVIDER_ERROR', details: { summary: 'http_400' } })
    const internal = internalDetailsOf(error) as { providerMessage: string }
    expect(internal.providerMessage).toContain("required scope 'files.metadata.read'")
    expect(JSON.stringify(toErrorResponse(error))).not.toContain('files.metadata.read')
  })

  it('ignores a plain body that is not text/plain, and an HTML body', () => {
    expect(providerMessage('<html>proxy error</html>', 400)).toBeUndefined()
    expect(providerMessage(MISSING_SCOPE_TEXT, 400, 'text/html')).toBeUndefined()
    expect(providerMessage(MISSING_SCOPE_TEXT, 500, 'text/plain')).toBeUndefined()
  })

  it('reads user_message.text and a structured missing_scope error', () => {
    expect(providerMessage(JSON.stringify({ error_summary: 'x/', user_message: { text: 'Try again later.' } }), 409)).toBe(
      'Try again later.',
    )
    const scoped = toDropboxError(
      401,
      JSON.stringify({
        error_summary: 'missing_scope/',
        error: { '.tag': 'missing_scope', required_scope: 'files.content.read' },
      }),
      context,
    )
    expect(scoped).toMatchObject({ code: 'DRIVE_CREDENTIALS_INVALID' })
    expect(internalDetailsOf(scoped)).toEqual({
      providerMessage: 'The app is missing the required scope "files.content.read".',
    })
  })

  it('carries nothing for a JSON body without an allow-listed field', () => {
    const error = toDropboxError(409, JSON.stringify({ error_summary: 'path/conflict/file/.' }), context)
    expect(internalDetailsOf(error)).toBeUndefined()
  })
})
