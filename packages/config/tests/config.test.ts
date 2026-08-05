import { describe, expect, it } from 'vitest'
import { createApp } from '@machize/core'
import { CONFIG, ConfigRepository, configPlugin } from '../src/index.js'

describe('ConfigRepository', () => {
  const repo = () =>
    new ConfigRepository({ mail: { from: 'oi@machize.dev', smtp: { port: 587 } } })

  it('lê por dot-path', () => {
    expect(repo().get('mail.from')).toBe('oi@machize.dev')
    expect(repo().get('mail.smtp.port')).toBe(587)
  })

  it('usa fallback quando ausente e lança sem fallback', () => {
    expect(repo().get('mail.replyTo', 'x@y.z')).toBe('x@y.z')
    expect(() => repo().get('mail.replyTo')).toThrowError(/mail\.replyTo/)
  })

  it('has/set criam caminhos intermediários', () => {
    const config = repo()
    expect(config.has('queue.driver')).toBe(false)
    config.set('queue.driver', 'bullmq')
    expect(config.get('queue.driver')).toBe('bullmq')
  })

  it('merge faz deep merge sem apagar irmãos', () => {
    const config = repo()
    config.merge({ mail: { smtp: { host: 'smtp.acme.com' } } })
    expect(config.get('mail.smtp.port')).toBe(587)
    expect(config.get('mail.smtp.host')).toBe('smtp.acme.com')
  })

  it('configPlugin registra o repositório no container sem compartilhar o objeto original', async () => {
    const values = { app: { name: 'demo' } }
    const app = await createApp({ plugins: [configPlugin(values)] }).boot()
    const config = app.container.get(CONFIG)
    config.set('app.name', 'mutado')
    expect(values.app.name).toBe('demo')
    expect(config.get('app.name')).toBe('mutado')
  })
})
