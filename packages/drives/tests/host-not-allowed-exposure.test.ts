import { toErrorResponse } from '@basaltkit/http'
import { describe, expect, it } from 'vitest'
import { DriveHostNotAllowedError } from '../src/errors.js'

describe('DriveHostNotAllowedError never names the refused host to the client', () => {
  it('keeps host and reason for the log and events, sends only the code and a neutral message', () => {
    const error = new DriveHostNotAllowedError('db.internal', 'fake', 'the address failed validation')
    expect(error.message).toContain('db.internal')
    expect(error.details).toMatchObject({ host: 'db.internal' })
    const response = toErrorResponse(error)
    expect(response.status).toBe(502)
    expect(response.body).toEqual({ error: { code: 'DRIVE_HOST_NOT_ALLOWED', message: 'Bad gateway.' } })
  })
})
