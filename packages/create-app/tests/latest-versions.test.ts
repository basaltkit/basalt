import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs, resolvesLatest } from '../src/args.js'
import { createProject } from '../src/index.js'
import {
  DEFAULT_MINIMUM_RELEASE_AGE_MINUTES,
  DEFAULT_REGISTRY,
  describeResolution,
  latestUrl,
  minimumReleaseAgeMinutes,
  registryUrl,
  resolveLatestVersions,
  THIRD_PARTY_VERSIONS,
} from '../src/latest-versions.js'
import { SCAFFOLD_VERSIONS } from '../src/versions.js'

/**
 * Scaffold-time "latest version" resolution. No test here touches the real
 * network: every registry is a fake fetch.
 */

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
type FakeRegistry = Record<string, unknown | Handler>

/** A `last-modified` far outside any release-age window. */
const LONG_AGO = 'Mon, 01 Jan 2024 00:00:00 GMT'

/**
 * A fetch answering `<registry>/<name>/latest` from a name → body/handler map,
 * and the release-age probe (`HEAD <registry>/<name>`) with a `last-modified`
 * from `modified` (default: long ago; `null` omits the header).
 */
function fakeFetch(
  entries: FakeRegistry,
  calls: string[] = [],
  modified: Record<string, string | null> = {},
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(init?.method === 'HEAD' ? `HEAD ${url}` : url)
    if (init?.method === 'HEAD') {
      const probe = /\/((?:@[^/]+%2f)?[^/]+)$/.exec(url)
      const name = probe ? decodeURIComponent(probe[1]!) : ''
      const lastModified = name in modified ? modified[name] : LONG_AGO
      return new Response(null, { status: 200, headers: lastModified ? { 'last-modified': lastModified } : {} })
    }
    const match = /\/((?:@[^/]+%2f)?[^/]+)\/latest$/.exec(url)
    const name = match ? decodeURIComponent(match[1]!) : ''
    const entry = entries[name]
    if (typeof entry === 'function') return (entry as Handler)(url, init)
    if (entry === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(entry), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
}

/** Only the `/latest` lookups (drops the release-age probes). */
const latestCalls = (calls: string[]): string[] => calls.filter((url) => url.endsWith('/latest'))

describe('resolveLatestVersions', () => {
  it('takes the latest @basaltkit/* version, even across majors', async () => {
    const result = await resolveLatestVersions(
      { '@basaltkit/core': '^1.3.0', '@basaltkit/auth': '^2.2.0' },
      { fetch: fakeFetch({ '@basaltkit/core': { version: '1.9.4' }, '@basaltkit/auth': { version: '3.0.1' } }) },
    )
    expect(result.versions).toEqual({ '@basaltkit/core': '^1.9.4', '@basaltkit/auth': '^3.0.1' })
    expect(result.resolved.sort()).toEqual(['@basaltkit/auth', '@basaltkit/core'])
    expect(result.failed).toEqual([])
    expect(result.heldBack).toEqual([])
  })

  it('takes a third-party latest on the template-compatible major', async () => {
    const result = await resolveLatestVersions(
      { typescript: '^7.0.2', zod: '^4.6.5' },
      { fetch: fakeFetch({ typescript: { version: '7.4.0' }, zod: { version: '4.9.1' } }) },
    )
    expect(result.versions).toEqual({ typescript: '^7.4.0', zod: '^4.9.1' })
    expect(result.heldBack).toEqual([])
  })

  it('keeps the fallback and reports a notice when a third-party latest is a new major', async () => {
    const result = await resolveLatestVersions(
      { typescript: '^7.0.2', vite: '^8.3.0' },
      { fetch: fakeFetch({ typescript: { version: '8.0.0' }, vite: { version: '8.5.0' } }) },
    )
    expect(result.versions).toEqual({ typescript: '^7.0.2', vite: '^8.5.0' })
    expect(result.heldBack).toEqual([{ name: 'typescript', latest: '8.0.0', range: '^7.0.2' }])
    expect(describeResolution(result).join('\n')).toMatch(/typescript 8\.0\.0 is a new major .* kept \^7\.0\.2/)
  })

  it('falls back on fetch rejection, non-2xx, malformed JSON, bogus versions and timeouts', async () => {
    const result = await resolveLatestVersions(
      {
        '@basaltkit/core': '^1.3.0',
        '@basaltkit/auth': '^2.2.0',
        zod: '^4.6.5',
        tsx: '^4.23.13',
        vitest: '^5.0.1',
        react: '^19.3.0',
        vite: '^8.3.0',
      },
      {
        timeoutMs: 50,
        fetch: fakeFetch({
          '@basaltkit/core': () => Promise.reject(new TypeError('fetch failed')),
          '@basaltkit/auth': () => new Response('oops', { status: 500 }),
          zod: () => new Response('{not json', { status: 200 }),
          tsx: { version: 'latest; rm -rf /' },
          vitest: { version: '5.1.0-beta.1' },
          react: { name: 'react' },
          // Never answers on its own — only the abort signal ends it.
          vite: (_url: string, init?: RequestInit) =>
            new Promise<Response>((_, reject) => {
              init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
            }),
        }),
      },
    )
    expect(result.resolved).toEqual([])
    expect(result.failed.sort()).toEqual(['@basaltkit/auth', '@basaltkit/core', 'react', 'tsx', 'vite', 'vitest', 'zod'])
    expect(result.versions['@basaltkit/core']).toBe('^1.3.0')
    expect(result.versions.zod).toBe('^4.6.5')
    const warning = describeResolution(result)
    expect(warning).toHaveLength(1)
    expect(warning[0]).toMatch(/^Warning: .*fallback ranges/)
  })

  it('aborts a hanging request after the per-request timeout', async () => {
    const hang: typeof globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })) as typeof globalThis.fetch
    const started = Date.now()
    const result = await resolveLatestVersions({ zod: '^4.6.5' }, { fetch: hang, timeoutMs: 30 })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result.failed).toEqual(['zod'])
    expect(result.versions.zod).toBe('^4.6.5')
  })

  it('caps the whole resolution with the overall timeout', async () => {
    const hang: typeof globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      })) as typeof globalThis.fetch
    const result = await resolveLatestVersions(
      { zod: '^4.6.5', tsx: '^4.23.13' },
      { fetch: hang, timeoutMs: 60_000, overallTimeoutMs: 30 },
    )
    expect(result.failed.sort()).toEqual(['tsx', 'zod'])
  })

  it('retries a transient failure once, but never a definitive miss', async () => {
    const calls: string[] = []
    let zodAttempts = 0
    const result = await resolveLatestVersions(
      { zod: '^4.6.5', tsx: '^4.23.13' },
      {
        fetch: fakeFetch(
          {
            zod: () => {
              zodAttempts++
              return zodAttempts === 1
                ? Promise.reject(new TypeError('fetch failed'))
                : new Response(JSON.stringify({ version: '4.7.0' }), { status: 200 })
            },
            // tsx: absent → 404, a definitive miss
          },
          calls,
        ),
      },
    )
    expect(result.versions).toEqual({ zod: '^4.7.0', tsx: '^4.23.13' })
    expect(calls.filter((url) => url.endsWith('/zod/latest'))).toHaveLength(2)
    expect(calls.filter((url) => url.endsWith('/tsx/latest'))).toHaveLength(1)
  })

  it('keeps at most `concurrency` requests in flight', async () => {
    let inFlight = 0
    let peak = 0
    const slow: typeof globalThis.fetch = (async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      return new Response(JSON.stringify({ version: '4.9.0' }), { status: 200 })
    }) as typeof globalThis.fetch
    const fallbacks = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`pkg-${i}`, '^4.0.0']))
    const result = await resolveLatestVersions(fallbacks, { fetch: slow, concurrency: 3, minimumReleaseAge: 0 })
    expect(peak).toBe(3)
    expect(result.resolved).toHaveLength(20)
  })

  it('queries <registry>/<name>/latest with scoped names encoded', async () => {
    const calls: string[] = []
    await resolveLatestVersions(
      { '@types/node': '^26.6.2', zod: '^4.6.5' },
      { fetch: fakeFetch({}, calls), registry: 'https://mirror.example.com/npm/' },
    )
    expect(latestCalls(calls).sort()).toEqual([
      'https://mirror.example.com/npm/@types%2fnode/latest',
      'https://mirror.example.com/npm/zod/latest',
    ])
    expect(latestUrl(DEFAULT_REGISTRY, '@basaltkit/core')).toBe('https://registry.npmjs.org/@basaltkit%2fcore/latest')
  })
})

describe('release-age window (pnpm minimumReleaseAge)', () => {
  const NOW = Date.parse('2026-09-19T12:00:00Z')
  const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toUTCString()

  it('keeps the fallback range for a third-party latest published inside the window', async () => {
    const calls: string[] = []
    const result = await resolveLatestVersions(
      { '@types/node': '^26.6.2', zod: '^4.6.5' },
      {
        now: () => NOW,
        fetch: fakeFetch(
          { '@types/node': { version: '26.9.0' }, zod: { version: '4.9.1' } },
          calls,
          { '@types/node': hoursAgo(3), zod: hoursAgo(72) },
        ),
      },
    )
    // ^26.9.0 would be unsatisfiable under pnpm 11's default 1-day
    // minimumReleaseAge; the bundled range lets pnpm pick the newest mature 26.x.
    expect(result.versions).toEqual({ '@types/node': '^26.6.2', zod: '^4.9.1' })
    expect(result.resolved).toEqual(['zod'])
    expect(result.tooFresh).toEqual([{ name: '@types/node', latest: '26.9.0', range: '^26.6.2', reason: 'recent' }])
    expect(calls).toContain(`HEAD ${DEFAULT_REGISTRY}/@types%2fnode`)
    expect(describeResolution(result).join('\n')).toMatch(/@types\/node 26\.9\.0 .*minimumReleaseAge.*kept \^26\.6\.2/)
  })

  it('treats an unprovable age (no last-modified, failed probe) as fresh', async () => {
    const result = await resolveLatestVersions(
      { tsx: '^4.23.13', vitest: '^5.0.1' },
      {
        now: () => NOW,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input)
          if (init?.method === 'HEAD') {
            return url.endsWith('/tsx') ? new Response(null, { status: 200 }) : new Response(null, { status: 405 })
          }
          return new Response(JSON.stringify({ version: url.includes('/tsx/') ? '4.30.0' : '5.2.0' }), { status: 200 })
        }) as typeof globalThis.fetch,
      },
    )
    expect(result.versions).toEqual({ tsx: '^4.23.13', vitest: '^5.0.1' })
    expect(result.tooFresh.map((entry) => [entry.name, entry.reason])).toEqual([
      ['tsx', 'unknown'],
      ['vitest', 'unknown'],
    ])
  })

  it('measures the age against the registry clock (Date header) when present', async () => {
    const result = await resolveLatestVersions(
      { zod: '^4.6.5' },
      {
        // The local clock is a week fast; the registry says it is 2h after publish.
        now: () => NOW + 7 * 86_400_000,
        fetch: (async (_input: string | URL | Request, init?: RequestInit) =>
          init?.method === 'HEAD'
            ? new Response(null, { status: 200, headers: { 'last-modified': hoursAgo(2), date: new Date(NOW).toUTCString() } })
            : new Response(JSON.stringify({ version: '4.9.1' }), { status: 200 })) as typeof globalThis.fetch,
      },
    )
    expect(result.versions.zod).toBe('^4.6.5')
    expect(result.tooFresh[0]?.reason).toBe('recent')
  })

  it('never probes @basaltkit/* (excluded by the scaffolded pnpm-workspace.yaml)', async () => {
    const calls: string[] = []
    const result = await resolveLatestVersions(
      { '@basaltkit/core': '^1.3.0' },
      { now: () => NOW, fetch: fakeFetch({ '@basaltkit/core': { version: '1.9.0' } }, calls, { '@basaltkit/core': hoursAgo(1) }) },
    )
    expect(result.versions['@basaltkit/core']).toBe('^1.9.0')
    expect(calls.some((call) => call.startsWith('HEAD '))).toBe(false)
  })

  it('honors minimumReleaseAge (option, then pnpm_config_minimum_release_age) and 0 disables the probe', async () => {
    const registry = { zod: { version: '4.9.1' } }
    const modified = { zod: hoursAgo(3) }
    const twoHours = await resolveLatestVersions({ zod: '^4.6.5' }, { now: () => NOW, minimumReleaseAge: 120, fetch: fakeFetch(registry, [], modified) })
    expect(twoHours.versions.zod).toBe('^4.9.1')

    const calls: string[] = []
    const off = await resolveLatestVersions({ zod: '^4.6.5' }, { now: () => NOW, minimumReleaseAge: 0, fetch: fakeFetch(registry, calls, modified) })
    expect(off.versions.zod).toBe('^4.9.1')
    expect(calls.some((call) => call.startsWith('HEAD '))).toBe(false)

    const previous = process.env['pnpm_config_minimum_release_age']
    process.env['pnpm_config_minimum_release_age'] = '60'
    try {
      const fromEnv = await resolveLatestVersions({ zod: '^4.6.5' }, { now: () => NOW, fetch: fakeFetch(registry, [], modified) })
      expect(fromEnv.versions.zod).toBe('^4.9.1')
    } finally {
      if (previous === undefined) delete process.env['pnpm_config_minimum_release_age']
      else process.env['pnpm_config_minimum_release_age'] = previous
    }
    expect(minimumReleaseAgeMinutes(undefined, {})).toBe(DEFAULT_MINIMUM_RELEASE_AGE_MINUTES)
    expect(minimumReleaseAgeMinutes(undefined, { npm_config_minimum_release_age: '30' })).toBe(30)
    expect(minimumReleaseAgeMinutes(undefined, { npm_config_minimum_release_age: 'soon' })).toBe(DEFAULT_MINIMUM_RELEASE_AGE_MINUTES)
  })
})

describe('registryUrl', () => {
  it('honors npm_config_registry and normalizes the trailing slash', () => {
    expect(registryUrl(undefined, { npm_config_registry: 'https://npm.corp.example/' })).toBe('https://npm.corp.example')
    expect(registryUrl(undefined, {})).toBe(DEFAULT_REGISTRY)
    expect(registryUrl(undefined, { npm_config_registry: 'file:///etc/passwd' })).toBe(DEFAULT_REGISTRY)
    expect(registryUrl(undefined, { npm_config_registry: 'not a url' })).toBe(DEFAULT_REGISTRY)
    expect(registryUrl('https://explicit.example//', { npm_config_registry: 'https://env.example' })).toBe(
      'https://explicit.example',
    )
  })

  it('is used by default when resolving', async () => {
    const previous = process.env['npm_config_registry']
    process.env['npm_config_registry'] = 'https://env-registry.example/'
    const calls: string[] = []
    try {
      const result = await resolveLatestVersions({ zod: '^4.6.5' }, { fetch: fakeFetch({}, calls) })
      expect(result.registry).toBe('https://env-registry.example')
      expect(latestCalls(calls)).toEqual(['https://env-registry.example/zod/latest'])
    } finally {
      if (previous === undefined) delete process.env['npm_config_registry']
      else process.env['npm_config_registry'] = previous
    }
  })
})

describe('CLI flags', () => {
  it('resolves latest by default and skips the registry with --offline', () => {
    expect(resolvesLatest(parseArgs(['my-app']))).toBe(true)
    expect(resolvesLatest(parseArgs(['my-app', '--offline']))).toBe(false)
  })
})

describe('createProject with resolveLatest', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'create-basalt-latest-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const bumpMinor = (range: string): string => {
    const [major, minor] = range.slice(1).split('.').map(Number) as [number, number]
    return `${major}.${minor + 7}.3`
  }
  const registry = (): FakeRegistry => {
    const entries: FakeRegistry = {}
    for (const [name, range] of Object.entries({ ...SCAFFOLD_VERSIONS, ...THIRD_PARTY_VERSIONS })) {
      entries[name] = { version: bumpMinor(range) }
    }
    return entries
  }

  it('writes ^<latest> into the root and web package.json', async () => {
    const calls: string[] = []
    const result = await createProject({
      name: 'fresh',
      dir: join(root, 'fresh'),
      ui: true,
      cli: true,
      mcp: true,
      billing: true,
      resolveLatest: true,
      registry: { fetch: fakeFetch(registry(), calls), registry: 'https://registry.test' },
    })
    const pkg = JSON.parse(await readFile(join(result.dir, 'package.json'), 'utf8'))
    const web = JSON.parse(await readFile(join(result.dir, 'web/package.json'), 'utf8'))
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...web.dependencies, ...web.devDependencies }
    for (const [name, range] of Object.entries(all)) {
      const fallback = SCAFFOLD_VERSIONS[name] ?? THIRD_PARTY_VERSIONS[name]
      expect(fallback, name).toBeDefined()
      expect(range, name).toBe(`^${bumpMinor(fallback!)}`)
    }
    expect(web.devDependencies.typescript).toBe(`^${bumpMinor(THIRD_PARTY_VERSIONS['typescript']!)}`)
    // One lookup per distinct package, all against the chosen registry, plus
    // one release-age probe per third-party package (never for @basaltkit/*).
    expect(new Set(calls).size).toBe(calls.length)
    expect(latestCalls(calls).length).toBe(Object.keys(all).length)
    const probes = calls.filter((call) => call.startsWith('HEAD '))
    expect(probes.length).toBe(Object.keys(all).filter((name) => !name.startsWith('@basaltkit/')).length)
    expect(probes.some((call) => call.includes('@basaltkit'))).toBe(false)
    expect(calls.every((url) => url.replace(/^HEAD /, '').startsWith('https://registry.test/'))).toBe(true)
    expect(result.versions?.failed).toEqual([])
  })

  it('never touches the network by default (programmatic API)', async () => {
    const spy = vi.fn(fakeFetch(registry()))
    const result = await createProject({
      name: 'offline',
      dir: join(root, 'offline'),
      ui: true,
      registry: { fetch: spy as unknown as typeof globalThis.fetch },
    })
    expect(spy).not.toHaveBeenCalled()
    expect(result.versions).toBeUndefined()
    const pkg = JSON.parse(await readFile(join(result.dir, 'package.json'), 'utf8'))
    expect(pkg.devDependencies.typescript).toBe(THIRD_PARTY_VERSIONS['typescript'])
  })

  it('keeps the bundled ranges when the registry is unreachable', async () => {
    const result = await createProject({
      name: 'down',
      dir: join(root, 'down'),
      resolveLatest: true,
      registry: { fetch: (() => Promise.reject(new TypeError('fetch failed'))) as typeof globalThis.fetch },
    })
    const pkg = JSON.parse(await readFile(join(result.dir, 'package.json'), 'utf8'))
    expect(pkg.dependencies['@basaltkit/core']).toBe(SCAFFOLD_VERSIONS['@basaltkit/core'])
    expect(pkg.devDependencies.vitest).toBe(THIRD_PARTY_VERSIONS['vitest'])
    expect(result.versions?.resolved).toEqual([])
    expect(result.versions?.failed.length).toBeGreaterThan(5)
  })
})

describe('web UI template (Tailwind 4)', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'create-basalt-tw-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('emits @tailwindcss/vite and no tailwind.config / postcss.config', async () => {
    const result = await createProject({ name: 'tw', dir: join(root, 'tw'), ui: true })
    expect(result.files).not.toContain('web/tailwind.config.js')
    expect(result.files).not.toContain('web/postcss.config.js')
    const web = JSON.parse(await readFile(join(result.dir, 'web/package.json'), 'utf8'))
    expect(web.devDependencies).toHaveProperty('@tailwindcss/vite')
    expect(web.devDependencies.tailwindcss).toMatch(/^\^4\./)
    expect(web.devDependencies).not.toHaveProperty('postcss')
    expect(web.devDependencies).not.toHaveProperty('autoprefixer')
    expect(web.dependencies.react).toMatch(/^\^19\./)
    expect(web.scripts.typecheck).toBe('tsc --noEmit')
    // TS 6+ checks side-effect imports: vite/client types `import './index.css'`.
    const tsconfig = JSON.parse(await readFile(join(result.dir, 'web/tsconfig.json'), 'utf8'))
    expect(tsconfig.compilerOptions.types).toContain('vite/client')
    const vite = await readFile(join(result.dir, 'web/vite.config.ts'), 'utf8')
    expect(vite).toContain("import tailwindcss from '@tailwindcss/vite'")
    expect(vite).toContain('plugins: [react(), tailwindcss()]')
    const css = await readFile(join(result.dir, 'web/src/index.css'), 'utf8')
    expect(css).toContain("@import 'tailwindcss';")
    expect(css).toContain("@source '../node_modules/@basaltkit/admin-shadcn/dist';")
    expect(css).toContain('@custom-variant dark (&:is(.dark *));')
    expect(css).not.toContain('@tailwind base')
    for (const token of ['border', 'input', 'ring', 'background', 'foreground', 'primary', 'secondary', 'destructive', 'muted', 'accent', 'card']) {
      expect(css).toContain(`--color-${token}: hsl(var(--${token}));`)
    }
    for (const size of ['lg', 'md', 'sm']) expect(css).toContain(`--radius-${size}:`)
  })
})
