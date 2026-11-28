import { describe, expect, it } from 'vitest'
import { proxiedPorts, renderVhost } from '../src/apache.js'
import { renderSite } from '../src/caddy.js'
import { apache, caddy, validateConfig } from '../src/config.js'
import { parseInstallPlan, PLAN_KIND } from '../src/install-plan.js'
import { acmeConfig, context, DIR, FakeHost } from './fake-host.js'

// An API on a host of its own (api.example.com), its frontend elsewhere or
// none: apiPrefix '' sends the whole host to the app and serves no web root.
// Found on three apps (lobito, smartland, kissamaagro): before, managed mode
// refused '', so they fell back to none() or an unmanaged vhost.
describe("managed proxy with apiPrefix '' (the whole host is the API)", () => {
  const api = (proxy: ReturnType<typeof caddy> | ReturnType<typeof apache>) =>
    ({ ...context(new FakeHost()), config: acmeConfig({ tenants: 'none', proxy, build: {} }) })

  it('Caddy: one reverse_proxy, no root, no file_server', () => {
    const site = renderSite(api(caddy({ apiPrefix: '' })), 3100)
    expect(site).toContain('reverse_proxy 127.0.0.1:3100 {')
    expect(site).not.toMatch(/handle|strip_prefix|file_server|root \*|try_files/)
    // The prefixed form is unchanged.
    const web = renderSite(api(caddy()), 3100)
    expect(web).toContain('handle /api/* {')
    expect(web).toContain(`root * ${DIR}/web/dist`)
  })

  it('Apache: ProxyPass / and no DocumentRoot; C1 still reads the port', () => {
    const vhost = renderVhost(api(apache({ apiPrefix: '' })), 3100)
    expect(vhost).toContain('ProxyPass / http://127.0.0.1:3100/ upgrade=websocket')
    expect(vhost).toContain('ProxyPassReverse / http://127.0.0.1:3100/')
    expect(vhost).not.toMatch(/^\s*(DocumentRoot|<Directory|FallbackResource)/m)
    expect(vhost).toContain('SSLCertificateFile /etc/letsencrypt/live/acme.example.com/fullchain.pem')
    expect(proxiedPorts(vhost)).toEqual([3100])
  })

  it("is valid managed; with build.web it is refused (that web would never be served)", () => {
    expect(() => validateConfig(acmeConfig({ tenants: 'none', proxy: caddy({ apiPrefix: '' }), build: {} }))).not.toThrow()
    expect(() => validateConfig(acmeConfig({ tenants: 'none', proxy: apache({ apiPrefix: '' }), build: { web: 'web' } }))).toThrow(
      /apiPrefix '' makes acme\.example\.com API only \(no web root\), but build\.web builds "web"/,
    )
    expect(() => validateConfig(acmeConfig({ proxy: caddy({ apiPrefix: '/' }) }))).toThrow(/must be a URL path such as \/api, or ''/)
  })

  it("root's install accepts the plan; anything else that is not a path is still refused", () => {
    const plan = (apiPrefix: string) => JSON.stringify({
      kind: PLAN_KIND, version: 1, app: 'acme', domain: 'api.acme.example.com', tenants: 'none', dir: DIR, port: 3100,
      proxy: { kind: 'caddy', managed: true, webRoot: 'web/dist', apiPrefix }, envFiles: [], docker: false, tool: '0.11.0',
    })
    expect(parseInstallPlan(plan(''), 'plan.json').proxy).toMatchObject({ apiPrefix: '' })
    expect(() => parseInstallPlan(plan('api; rm'), 'plan.json')).toThrow(/apiPrefix must be a URL path such as \/api, or ''/)
  })
})
