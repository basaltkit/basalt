import { describe, expect, it } from 'vitest'
import { apache, applyOverrides, DeployConfigError, dockerInfra, parseOverrides, pm2, validateConfig } from '../src/config.js'
import { lexfirmaConfig } from './fake-host.js'

describe('validateConfig', () => {
  it('accepts the LexFirma config', () => {
    expect(() => validateConfig(lexfirmaConfig())).not.toThrow()
  })

  it('C4: refuses a process name the app does not own', () => {
    // The shared server runs a production app as PM2 "api".
    for (const name of ['api', 'other-api', 'all']) {
      expect(() => validateConfig(lexfirmaConfig({ runtime: pm2({ name }) }))).toThrow(/must start with "lexfirma-"/)
    }
  })

  it('refuses names that could escape into paths or commands', () => {
    const bad = [
      lexfirmaConfig({ app: 'Lex Firma' }),
      lexfirmaConfig({ domain: 'lexfirma.aipro.ao/x' }),
      lexfirmaConfig({ proxy: apache({ vhost: '../../evil.conf' }) }),
      lexfirmaConfig({ infra: dockerInfra('lexfirma', { minio: { buckets: ['UPPER'] } }) }),
    ]
    for (const config of bad) expect(() => validateConfig(config)).toThrow(DeployConfigError)
  })

  it('refuses a key both forbidden and set', () => {
    const config = lexfirmaConfig()
    config.env.forbid = ['NODE_ENV']
    expect(() => validateConfig(config)).toThrow(/both forbidden and set/)
  })
})

describe('server overrides', () => {
  it('apply port, branch and infra ports; nothing else', () => {
    const base = lexfirmaConfig({ infra: dockerInfra('lexfirma', { minio: { buckets: ['lexfirma-documents'] } }) })
    const next = applyOverrides(base, { port: 3002, branch: 'main', infra: { postgres: { port: 5434 }, minio: { consolePort: 9111 } } })
    expect(next.runtime.port).toBe(3002)
    expect(next.branch).toBe('main')
    expect(next.infra).toMatchObject({ postgres: { port: 5434 }, minio: { consolePort: 9111, port: 'auto' } })
    expect(base.runtime.port).toBe('auto')
  })

  it('reject unknown keys and non-objects', () => {
    expect(() => parseOverrides('{"prot": 1}', '/etc/basalt/x.json')).toThrow(/unknown keys prot/)
    expect(() => parseOverrides('[]', 'x')).toThrow(/JSON object/)
    expect(() => parseOverrides('{', 'x')).toThrow(/not valid JSON/)
    expect(() => parseOverrides('{"__proto__": {"port": 1}}', 'x')).toThrow(/unknown keys __proto__/)
  })
})
