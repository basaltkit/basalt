import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { authRoutes } from '../src/routes.js'

/**
 * F-22 · The password rule is the application's to set.
 *
 * `authRoutes()` hard-coded `min(8)` and took no options. Eight characters is
 * the 2012 minimum; an application holding case files, draft pleadings and
 * client records has every reason to ask for more, and no way to do it without
 * abandoning the package's routes.
 *
 * One application worked around it by reaching into the route's Zod object and
 * swapping the `password` field while preserving the rest. That works and
 * depends on the internal shape of a body it does not own — any change here
 * breaks it silently, with no compile error.
 *
 * The default stays at 8 so nobody's existing routes start rejecting logins.
 */
const corpoDe = (routes: ReturnType<typeof authRoutes>, url: string) => {
  const r = routes.find((x) => x.url === url)
  if (!r?.body) throw new Error(`sem corpo em ${url}`)
  return r.body as z.ZodType
}

describe('F-22 · authRoutes({ password })', () => {
  it('keeps min(8) by default', () => {
    // Not a preference — a compatibility promise. Raising the default would
    // start rejecting passwords that already work.
    const body = corpoDe(authRoutes(), '/auth/register')
    expect(body.safeParse({ email: 'a@b.pt', password: '12345678' }).success).toBe(true)
    expect(body.safeParse({ email: 'a@b.pt', password: '1234567' }).success).toBe(false)
  })

  it('accepts a minimum length', () => {
    const body = corpoDe(authRoutes({ password: { minLength: 12 } }), '/auth/register')
    expect(body.safeParse({ email: 'a@b.pt', password: '12345678' }).success).toBe(false)
    expect(body.safeParse({ email: 'a@b.pt', password: '123456789012' }).success).toBe(true)
  })

  it('accepts a whole schema, for rules a length cannot express', () => {
    // "At least one non-alphanumeric", "not the email", a breach-list check —
    // none of those are a number, and an option that only took a number would
    // send those applications back to patching the route's Zod object.
    const schema = z
      .string()
      .min(10)
      .refine((p) => /[^a-zA-Z0-9]/.test(p), 'needs a symbol')

    const body = corpoDe(authRoutes({ password: schema }), '/auth/register')
    expect(body.safeParse({ email: 'a@b.pt', password: 'abcdefghijk' }).success).toBe(false)
    expect(body.safeParse({ email: 'a@b.pt', password: 'abcdefghij!' }).success).toBe(true)
  })

  it('applies to password reset too, not just register', () => {
    /**
     * The reset route carried its own `min(8)`. A policy that covered register
     * and left reset behind would let anyone walk a strong password back down
     * to eight characters through "forgot password" — the loophole is worse
     * than not having the option.
     */
    const routes = authRoutes({ password: { minLength: 12 } })
    const body = corpoDe(routes, '/auth/password/reset')

    expect(body.safeParse({ token: 't', password: '12345678' }).success).toBe(false)
    expect(body.safeParse({ token: 't', password: '123456789012' }).success).toBe(true)
  })

  it('leaves the email rule alone', () => {
    const body = corpoDe(authRoutes({ password: { minLength: 12 } }), '/auth/register')
    expect(body.safeParse({ email: 'nao-e-email', password: '123456789012' }).success).toBe(false)
  })
})
