import { describe, expect, it } from 'vitest'
import { Gate, MemoryAccessStore, GLOBAL_SCOPE, permissionMatches, permitted } from '../src/index.js'

/**
 * Framework audit residual: an empty segment is never a permission. `'projects:*'`
 * used to grant `'projects:'` (the wildcard matched the empty action) and `''`
 * matched `''` through the exact-equality shortcut.
 */
describe('permissionMatches · empty segments never match', () => {
  it.each([
    ['projects:*', 'projects:'],
    ['', ''],
    ['*', ''],
    ['*:*', ':'],
    ['projects:', 'projects:'],
    [':read', ':read'],
    ['projects::read', 'projects::read'],
    ['projects:*:read', 'projects::read'],
    ['*', 'projects:'],
    ['*', ':'],
  ])('%j does not grant %j', (granted, requested) => {
    expect(permissionMatches(granted, requested)).toBe(false)
  })

  it('still matches well-formed permissions', () => {
    expect(permissionMatches('projects:*', 'projects:read')).toBe(true)
    expect(permissionMatches('*', 'projects:read')).toBe(true)
    expect(permissionMatches('projects:read', 'projects:read')).toBe(true)
    expect(permitted(['', 'projects:*'], 'projects:')).toBe(false)
  })
})

describe('Gate · permissions with empty segments are refused', () => {
  const gate = () => new Gate({ store: new MemoryAccessStore() })

  it.each(['projects:', ':read', 'projects::read', ':', 'a:b:'])('can() rejects %j with a TypeError', async (p) => {
    await expect(gate().can({ id: 'u1' }, p)).rejects.toThrow(TypeError)
  })

  it.each(['projects:', ':read', 'projects::read'])('grantToUser() rejects %j', async (p) => {
    await expect(gate().grantToUser('u1', [p], GLOBAL_SCOPE)).rejects.toThrow(TypeError)
  })

  it('roleCatalog refuses a permission with an empty segment', () => {
    expect(() => new Gate({ store: new MemoryAccessStore(), roleCatalog: { admin: ['projects:'] } })).toThrow(TypeError)
  })
})

describe('MemoryAccessStore · direct writes refuse empty role names', () => {
  it.each(['', undefined, null, 42])('assignRole/grantToRole/removeRole refuse role %j', async (role) => {
    const store = new MemoryAccessStore()
    await expect(store.assignRole('u1', role as never, 's')).rejects.toThrow(TypeError)
    await expect(store.grantToRole(role as never, ['a:b'], 's')).rejects.toThrow(TypeError)
  })
})
