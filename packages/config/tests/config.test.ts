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

  it('configPlugin registers the repository in the container without sharing the original object', async () => {
    const values = { app: { name: 'demo' } }
    const app = await createApp({ plugins: [configPlugin(values)] }).boot()
    const config = app.container.get(CONFIG)
    config.set('app.name', 'mutado')
    expect(values.app.name).toBe('demo')
    expect(config.get('app.name')).toBe('mutado')
  })
})
