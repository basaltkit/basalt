import { describe, expect, it } from 'vitest'
import { resolveDevEntry, resolveDevRunner, DEV_ENTRY_CANDIDATES } from '../src/index.js'

describe('dev entry + runner resolution', () => {
  it('picks the first existing entry candidate', () => {
    const exists = (p: string) => p === 'src/index.ts'
    expect(resolveDevEntry(DEV_ENTRY_CANDIDATES, exists)).toBe('src/index.ts')
    expect(resolveDevEntry(DEV_ENTRY_CANDIDATES, () => false)).toBeUndefined()
  })

  it('uses tsx watch for TS when tsx is available', () => {
    expect(resolveDevRunner('src/main.ts', { tsx: true })).toEqual({ command: 'tsx', args: ['watch', 'src/main.ts'] })
  })

  it('falls back to node --watch --experimental-strip-types for TS without tsx', () => {
    expect(resolveDevRunner('src/main.ts', { tsx: false })).toEqual({
      command: 'node',
      args: ['--watch', '--experimental-strip-types', 'src/main.ts'],
    })
  })

  it('runs plain JS with node --watch', () => {
    expect(resolveDevRunner('src/main.js')).toEqual({ command: 'node', args: ['--watch', 'src/main.js'] })
  })
})

import { devRouteRows } from '../src/index.js'

describe('devRouteRows (dev route table)', () => {
  it('sorts by url then method and derives a flags column', () => {
    const rows = devRouteRows([
      { method: 'post', url: '/projects', meta: { auth: true, tags: ['Projects'] } },
      { method: 'get', url: '/health' },
      { method: 'get', url: '/projects', meta: { rateLimit: { max: 10 } } },
    ])
    expect(rows).toEqual([
      { method: 'GET', url: '/health', flags: '' },
      { method: 'GET', url: '/projects', flags: 'rate-limit' },
      { method: 'POST', url: '/projects', flags: 'auth, Projects' },
    ])
  })

  it('returns an empty list for no routes', () => {
    expect(devRouteRows([])).toEqual([])
  })
})
