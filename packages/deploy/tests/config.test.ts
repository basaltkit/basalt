import { describe, expect, it } from 'vitest'
import { apache, applyOverrides, DeployConfigError, dockerInfra, parseOverrides, pm2, validateConfig } from '../src/config.js'
import { acmeConfig } from './fake-host.js'

describe('validateConfig', () => {
  it('accepts the Acme config', () => {
    expect(() => validateConfig(acmeConfig())).not.toThrow()
  })

  it('C4: refuses a process name the app does not own', () => {
    // The shared server runs a production app as PM2 "api".
    for (const name of ['api', 'other-api', 'all']) {
      expect(() => validateConfig(acmeConfig({ runtime: pm2({ name }) }))).toThrow(/must start with "acme-"/)
    }
  })

  it('refuses names that could escape into paths or commands', () => {
    const bad = [
      acmeConfig({ app: 'Lex Firma' }),
      acmeConfig({ domain: 'acme.example.com/x' }),
      acmeConfig({ proxy: apache({ vhost: '../../evil.conf' }) }),
      acmeConfig({ infra: dockerInfra('acme', { minio: { buckets: ['UPPER'] } }) }),
    ]
    for (const config of bad) expect(() => validateConfig(config)).toThrow(DeployConfigError)
  })

  it('refuses a key both forbidden and set', () => {
    const config = acmeConfig()
    config.env.forbid = ['NODE_ENV']
    expect(() => validateConfig(config)).toThrow(/both forbidden and set/)
  })
})

describe('server overrides', () => {
  it('apply port, branch and infra ports; nothing else', () => {
    const base = acmeConfig({ infra: dockerInfra('acme', { minio: { buckets: ['acme-documents'] } }) })
    const next = applyOverrides(base, { port: 3002, branch: 'main', infra: { postgres: { port: 5434 }, minio: { consolePort: 9111 } } })
    expect(next.runtime).toMatchObject({ kind: 'pm2', port: 3002 })
    expect(next.branch).toBe('main')
    expect(next.infra).toMatchObject({ postgres: { port: 5434 }, minio: { consolePort: 9111, port: 'auto' } })
    expect(base.runtime).toMatchObject({ port: 'auto' })
  })

  it('reject unknown keys and non-objects', () => {
    expect(() => parseOverrides('{"prot": 1}', '/etc/basalt/x.json')).toThrow(/unknown keys prot/)
    expect(() => parseOverrides('[]', 'x')).toThrow(/JSON object/)
    expect(() => parseOverrides('{', 'x')).toThrow(/not valid JSON/)
    expect(() => parseOverrides('{"__proto__": {"port": 1}}', 'x')).toThrow(/unknown keys __proto__/)
  })
})
