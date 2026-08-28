import { describe, expect, it } from 'vitest'
import { runWithContext } from '@basaltkit/core'
import { requireTenant, requireTenantId, tenantScoped, TenantRequiredError } from '../src/index.js'

const acme = { id: 'acme', name: 'Acme Inc' }

describe('requireTenant', () => {
  it('returns the context tenant', () => {
    runWithContext({ tenant: acme }, () => {
      expect(requireTenant()).toEqual(acme)
    })
  })

  it('fails closed outside a tenant context', () => {
    expect(() => requireTenant()).toThrowError(TenantRequiredError)
    runWithContext({}, () => {
      expect(() => requireTenant()).toThrowError(TenantRequiredError)
    })
  })
})

describe('requireTenantId', () => {
  it('context tenant always wins — a fallback cannot widen the scope', () => {
    runWithContext({ tenant: acme }, () => {
      expect(requireTenantId()).toBe('acme')
      // anti-widening: client-supplied id is ignored when a tenant is resolved
      expect(requireTenantId('globex')).toBe('acme')
    })
  })

  it('honours an explicit fallback when no tenant is in context (system code)', () => {
    expect(requireTenantId('globex')).toBe('globex')
  })

  it('throws instead of returning undefined when there is nothing to scope to', () => {
    expect(() => requireTenantId()).toThrowError(TenantRequiredError)
  })

  it('maps to HTTP 400 via the standard BasaltError status contract', () => {
    try {
      requireTenantId()
      expect.unreachable()
    } catch (error) {
      expect((error as TenantRequiredError).status).toBe(400)
      expect((error as TenantRequiredError).code).toBe('TENANT_REQUIRED')
    }
  })
})

describe('tenantScoped', () => {
  it('spreads tenantId last — a smuggled tenantId in where cannot override the context', () => {
    runWithContext({ tenant: acme }, () => {
      expect(tenantScoped({ archived: false })).toEqual({ archived: false, tenantId: 'acme' })
      expect(tenantScoped({ tenantId: 'globex' })).toEqual({ tenantId: 'acme' })
    })
  })

  it('honours an explicit tenantId in where when no tenant is in context', () => {
    expect(tenantScoped({ tenantId: 'globex' })).toEqual({ tenantId: 'globex' })
  })

  it('fails closed with no tenant anywhere — never emits tenantId: undefined', () => {
    expect(() => tenantScoped({ archived: false })).toThrowError(TenantRequiredError)
    expect(() => tenantScoped()).toThrowError(TenantRequiredError)
  })
})
