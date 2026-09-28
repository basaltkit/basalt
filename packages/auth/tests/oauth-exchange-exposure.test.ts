import { toErrorResponse } from '@basaltkit/http'
import { describe, expect, it } from 'vitest'
import { OAuthExchangeError } from '../src/oauth.js'

describe('OAuthExchangeError never echoes the provider reply to the client', () => {
  it('keeps the detail on the error for the log, sends only the code and a neutral message', () => {
    const error = new OAuthExchangeError('invalid_grant: code redeemed for client 1234 at https://idp.internal/token')
    expect(error.message).toContain('idp.internal')
    const response = toErrorResponse(error)
    expect(response.status).toBe(502)
    expect(response.body).toEqual({ error: { code: 'AUTH_OAUTH_EXCHANGE_FAILED', message: 'Bad gateway.' } })
    expect(JSON.stringify(response.body)).not.toContain('idp.internal')
  })
})
