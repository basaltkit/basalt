import { describe, expect, it } from 'vitest'
import {
  DriveAccessDeniedError,
  DriveItemNotFoundError,
  DriveProviderError,
} from '../src/errors.js'

/**
 * The three codes the first adapter added. Each carries a `details` payload,
 * which `@basaltkit/http` serialises into a response body and
 * `@basaltkit/audit` stores — so what goes in there is effectively public.
 */
describe('the errors phase 2a added', () => {
  it('distinguishes a refused operation from a dead grant', () => {
    const error = new DriveAccessDeniedError('dropbox', 'access_denied/team_policy')
    expect(error.code).toBe('DRIVE_ACCESS_DENIED')
    expect(error.status).toBe(403)
    expect(error.details).toEqual({ provider: 'dropbox', reason: 'access_denied/team_policy' })
  })

  it('reports a missing item as a 404', () => {
    const error = new DriveItemNotFoundError('dropbox', 'id:a')
    expect(error.code).toBe('DRIVE_ITEM_NOT_FOUND')
    expect(error.status).toBe(404)
    expect(error.details).toEqual({ provider: 'dropbox', externalId: 'id:a' })
  })

  it('carries the vendor taxonomy and the adapter’s retry verdict', () => {
    const transient = new DriveProviderError('dropbox', 'internal_error/', 500, true)
    expect(transient.code).toBe('DRIVE_PROVIDER_ERROR')
    expect(transient.status).toBe(502)
    expect(transient.retryable).toBe(true)
    expect(transient.summary).toBe('internal_error/')
    expect(transient.details).toEqual({ provider: 'dropbox', summary: 'internal_error/', providerStatus: 500 })
    // Terminal by default: an unknown provider failure must not become a loop.
    expect(new DriveProviderError('dropbox', 'path/conflict/', 409).retryable).toBe(false)
  })
})
