import { describe, expect, it } from 'vitest'
import { Container, createToken, CircularDependencyError, CaptiveDependencyError } from '../src/index.js'

/**
 * Cross-scope cycle detection (ecosystem review 2026-08, finding Q2).
 *
 * The review suspected the per-instance `resolving` stack could miss cycles
 * spanning a parent container and a request scope. These tests probe every
 * cross-container shape we could construct. They pin the invariant: any true
 * cycle re-enters some (container, token) pair, and that container's own
 * stack catches it — regardless of which container the resolution started on.
 */

interface Service { name: string }
const A = createToken<Service>('a')
const B = createToken<Service>('b')
const C = createToken<Service>('c')

describe('cycle detection across scopes', () => {
  it('detects a cycle through a parent-owned singleton resolved from a scope', () => {
    const root = new Container()
    root.singleton(A, (c) => ({ name: `a+${c.get(B).name}` }))
    root.singleton(B, (c) => ({ name: `b+${c.get(A).name}` }))
    const scope = root.createScope()
    expect(() => scope.get(A)).toThrowError(CircularDependencyError)
  })

  it('detects a scoped → singleton → scoped cycle started on the scope', () => {
    const root = new Container()
    root.scoped(A, (c) => ({ name: `a+${c.get(B).name}` }))
    root.singleton(B, (c) => ({ name: `b+${c.get(A).name}` }))
    const scope = root.createScope()
    expect(() => scope.get(A)).toThrowError(CircularDependencyError)
  })

  it('detects a cycle even when factories capture DIFFERENT container instances', () => {
    // Pathological but possible: factories close over containers instead of
    // using the one they are handed, so the resolution ping-pongs between the
    // root's and the scope's stacks. The cycle must still be caught (as an
    // error, not a stack overflow) once any container sees a token re-enter.
    const root = new Container()
    const scope = root.createScope()
    root.singleton(A, () => ({ name: `a+${scope.get(B).name}` }))
    root.singleton(B, () => ({ name: `b+${root.get(A).name}` }))
    expect(() => scope.get(A)).toThrowError(CircularDependencyError)
  })

  it('detects a three-container ping-pong cycle (root + two scopes)', () => {
    const root = new Container()
    const scope1 = root.createScope()
    const scope2 = root.createScope()
    root.transient(A, () => ({ name: `a+${scope2.get(B).name}` }))
    root.transient(B, () => ({ name: `b+${root.get(C).name}` }))
    root.transient(C, () => ({ name: `c+${scope1.get(A).name}` }))
    expect(() => scope1.get(A)).toThrowError(CircularDependencyError)
  })

  it('does not false-positive on a legitimate diamond resolved through a scope', () => {
    const root = new Container()
    root.singleton(C, () => ({ name: 'c' }))
    root.singleton(B, (c) => ({ name: `b+${c.get(C).name}` }))
    root.scoped(A, (c) => ({ name: `a+${c.get(B).name}+${c.get(C).name}` }))
    const scope = root.createScope()
    expect(scope.get(A).name).toBe('a+b+c+c')
    // and a sibling scope resolves independently without tripping detection
    expect(root.createScope().get(A).name).toBe('a+b+c+c')
  })

  it('does not false-positive when the same token resolves sequentially in two scopes', () => {
    const root = new Container()
    let builds = 0
    root.scoped(A, () => ({ name: `a${++builds}` }))
    const s1 = root.createScope()
    const s2 = root.createScope()
    expect(s1.get(A).name).toBe('a1')
    expect(s2.get(A).name).toBe('a2')
    expect(s1.get(A).name).toBe('a1') // memoized per scope
  })
})

describe('captive dependency guard (fail-loud, review follow-up)', () => {
  const SCOPED = createToken<Service>('request-service')
  const SINGLETON = createToken<{ captured?: Service }>('app-service')

  it('throws when a singleton factory resolves a scoped token through a scope', () => {
    const root = new Container()
    root.scoped(SCOPED, () => ({ name: 'per-request' }))
    root.singleton(SINGLETON, (c) => ({ captured: c.get(SCOPED) }))
    const scope = root.createScope()
    expect(() => scope.get(SINGLETON)).toThrowError(CaptiveDependencyError)
    try {
      scope.get(SINGLETON)
    } catch (error) {
      const captive = error as CaptiveDependencyError
      expect(captive.code).toBe('DI_CAPTIVE_DEPENDENCY')
      expect(captive.message).toContain('request-service')
      expect(captive.message).toContain('app-service')
    }
  })

  it('throws at the root too (a root-resolved scoped token is equally captive)', () => {
    const root = new Container()
    root.scoped(SCOPED, () => ({ name: 'per-request' }))
    root.singleton(SINGLETON, (c) => ({ captured: c.get(SCOPED) }))
    expect(() => root.get(SINGLETON)).toThrowError(CaptiveDependencyError)
  })

  it('throws transitively: singleton → transient → scoped is still captive', () => {
    const root = new Container()
    root.scoped(SCOPED, () => ({ name: 'per-request' }))
    root.transient(B, (c) => ({ name: c.get(SCOPED).name }))
    root.singleton(SINGLETON, (c) => ({ captured: c.get(B) }))
    expect(() => root.createScope().get(SINGLETON)).toThrowError(CaptiveDependencyError)
  })

  it('legit graphs are untouched: singleton → singleton/transient, scoped → singleton', () => {
    const root = new Container()
    root.singleton(A, () => ({ name: 'a' }))
    root.transient(B, () => ({ name: 'b' }))
    root.singleton(SINGLETON, (c) => ({ captured: { name: `${c.get(A).name}${c.get(B).name}` } }))
    root.scoped(SCOPED, (c) => ({ name: `scoped+${c.get(A).name}` }))
    const scope = root.createScope()
    expect(scope.get(SINGLETON).captured?.name).toBe('ab')
    expect(scope.get(SCOPED).name).toBe('scoped+a')
  })

  it('a singleton managing its OWN scope deliberately is allowed', () => {
    const root = new Container()
    root.scoped(SCOPED, () => ({ name: 'per-run' }))
    root.singleton(SINGLETON, (c) => {
      const ownScope = (c as Container).createScope()
      return { captured: ownScope.get(SCOPED) }
    })
    expect(root.get(SINGLETON).captured?.name).toBe('per-run')
  })

  it('the guard resets after a build — later scoped resolutions work normally', () => {
    const root = new Container()
    root.scoped(SCOPED, () => ({ name: 'per-request' }))
    root.singleton(A, () => ({ name: 'a' }))
    const scope = root.createScope()
    expect(scope.get(A).name).toBe('a')
    expect(scope.get(SCOPED).name).toBe('per-request')
  })
})
