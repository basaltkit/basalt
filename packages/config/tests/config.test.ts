import { describe, expect, it } from 'vitest'
import { createApp } from '@basaltkit/core'
import { CONFIG, ConfigRepository, configPlugin } from '../src/index.js'

describe('ConfigRepository', () => {
  const repo = () =>
    new ConfigRepository({ mail: { from: 'oi@basalt.dev', smtp: { port: 587 } } })

  it('reads by dot-path', () => {
    expect(repo().get('mail.from')).toBe('oi@basalt.dev')
    expect(repo().get('mail.smtp.port')).toBe(587)
  })

  it('uses the fallback when missing and throws without a fallback', () => {
    expect(repo().get('mail.replyTo', 'x@y.z')).toBe('x@y.z')
    expect(() => repo().get('mail.replyTo')).toThrowError(/mail\.replyTo/)
  })

  it('has/set create intermediate paths', () => {
    const config = repo()
    expect(config.has('queue.driver')).toBe(false)
    config.set('queue.driver', 'bullmq')
    expect(config.get('queue.driver')).toBe('bullmq')
  })

  it('merge performs a deep merge without erasing siblings', () => {
    const config = repo()
    config.merge({ mail: { smtp: { host: 'smtp.acme.com' } } })
    expect(config.get('mail.smtp.port')).toBe(587)
    expect(config.get('mail.smtp.host')).toBe('smtp.acme.com')
  })

  it('merge ignores prototype-pollution keys and never touches Object.prototype', () => {
    const config = repo()
    config.merge(JSON.parse('{"__proto__": {"polluted": true}, "mail": {"from": "x@y.z"}}'))
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(config.get('mail.from')).toBe('x@y.z') // the safe key still merged
  })

  it('set refuses an unsafe key rather than polluting the prototype', () => {
    const config = repo()
    expect(() => config.set('__proto__.polluted', true)).toThrowError(/unsafe/i)
    expect(() => config.set('constructor', 'x')).toThrowError(/unsafe/i)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('configPlugin registers the repository in the container without sharing the original object', async () => {
    const values = { app: { name: 'demo' } }
    const app = await createApp({ plugins: [configPlugin(values)] }).boot()
    const config = app.container.get(CONFIG)
    config.set('app.name', 'mutado')
    expect(values.app.name).toBe('demo')
    expect(config.get('app.name')).toBe('mutado')
  })
})
