import { afterEach, describe, expect, it } from 'vitest'
import { isProductionEnvironment } from '../src/index.js'

describe('isProductionEnvironment() — fail-closed NODE_ENV policy', () => {
  const saved = process.env['NODE_ENV']
  afterEach(() => {
    if (saved === undefined) delete process.env['NODE_ENV']
    else process.env['NODE_ENV'] = saved
  })

  it('only an explicit development or test is non-production', () => {
    expect(isProductionEnvironment('development')).toBe(false)
    expect(isProductionEnvironment('test')).toBe(false)
  })

  it('unset, empty, staging and typos count as production', () => {
    for (const value of ['', 'production', 'staging', 'prod', 'Production', 'dev']) {
      expect(isProductionEnvironment(value)).toBe(true)
    }
  })

  it('reads process.env.NODE_ENV by default', () => {
    delete process.env['NODE_ENV']
    expect(isProductionEnvironment()).toBe(true)
    process.env['NODE_ENV'] = 'development'
    expect(isProductionEnvironment()).toBe(false)
  })

  it('vitest runs with NODE_ENV=test, so suites keep development defaults', () => {
    expect(saved).toBe('test')
  })
})
