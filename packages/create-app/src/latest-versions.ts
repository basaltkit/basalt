/**
 * Scaffold-time dependency resolution: a freshly generated app should depend on
 * the LATEST PUBLISHED version of every package, not on the ranges that were
 * current the day this create-basalt release was built.
 *
 * - `@basaltkit/*` packages always take the registry's `latest` dist-tag — the
 *   framework's own release line is the whole point of the scaffold.
 * - Third-party packages take `latest` only while it stays on the major the
 *   templates are written for (the major of the fallback range in
 *   {@link THIRD_PARTY_VERSIONS}). A new breaking major keeps the fallback range
 *   and is reported as a notice, so it can never silently produce a broken app.
 * - Third-party packages also respect pnpm's `minimumReleaseAge` (pnpm 11
 *   defaults it to one day): `^<latest>` for a version published minutes ago is
 *   UNSATISFIABLE under that policy, so the first `pnpm install` would fail. A
 *   cheap `HEAD <registry>/<name>` reads the packument's `last-modified` (which
 *   is never older than the latest publish): older than the window proves the
 *   latest mature and `^<latest>` is written; newer — or no header / a failed
 *   probe — keeps the fallback range, from which pnpm picks the newest MATURE
 *   version itself. The full packument (the only per-version `time` source) is
 *   megabytes for packages like `@types/node`, so it is never fetched; a
 *   false "fresh" only costs a lower range floor. `@basaltkit/*` is never
 *   probed: the scaffolded pnpm-workspace.yaml excludes that scope.
 * - Any registry failure (offline, timeout, non-2xx, malformed JSON, a bogus
 *   version string) keeps the embedded fallback range. The registry never fails
 *   a scaffold.
 */

/**
 * Fallback ranges for every third-party package the templates emit (API +
 * web UI). The major of each range is also the TEMPLATE-COMPATIBLE major: the
 * generated code is written for it, and `latest` is accepted only on that
 * major. Bump a range to a new major only together with the templates.
 */
export const THIRD_PARTY_VERSIONS: Readonly<Record<string, string>> = {
  '@tailwindcss/vite': '^4.3.3',
  '@types/node': '^26.6.2',
  '@types/react': '^19.3.0',
  '@types/react-dom': '^19.3.0',
  '@vitejs/plugin-react': '^6.1.1',
  'pino-pretty': '^13.1.3',
  react: '^19.3.0',
  'react-dom': '^19.3.0',
  tailwindcss: '^4.3.3',
  tsx: '^4.23.13',
  typescript: '^7.0.2',
  vite: '^8.3.0',
  vitest: '^5.0.1',
  zod: '^4.6.5',
}

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
/** pnpm 11's default `minimumReleaseAge`, in minutes (one day). */
export const DEFAULT_MINIMUM_RELEASE_AGE_MINUTES = 1440
const ABBREVIATED_METADATA = 'application/vnd.npm.install-v1+json'
const PER_REQUEST_TIMEOUT_MS = 5_000
const OVERALL_TIMEOUT_MS = 15_000
/**
 * Requests in flight at once. A burst of ~35 simultaneous TLS handshakes to one
 * host is markedly slower (and flakier) on poor links than a small pool that
 * reuses keep-alive connections.
 */
const CONCURRENCY = 8

/** A stable `x.y.z` release (pre-releases and build metadata are refused). */
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const CARET_RANGE = /^\^(0|[1-9]\d*)\.\d+\.\d+$/

/** Packages whose latest is always taken, regardless of major. */
export const alwaysLatest = (name: string): boolean =>
  name.startsWith('@basaltkit/') || name === 'create-basalt'

/** The major the templates are written for, derived from the fallback range. */
export function compatibleMajor(fallbackRange: string): number | undefined {
  const match = CARET_RANGE.exec(fallbackRange)
  return match ? Number(match[1]) : undefined
}

export interface HeldBackVersion {
  name: string
  /** The registry's latest version (a new major the templates don't target). */
  latest: string
  /** The range kept instead. */
  range: string
}

export interface FreshVersion {
  name: string
  /** The registry's latest version (same major, but possibly inside the release-age window). */
  latest: string
  /** The range kept instead. */
  range: string
  /** `recent`: published inside the window; `unknown`: its age could not be proven. */
  reason: 'recent' | 'unknown'
}

export interface VersionResolution {
  /** Final range per package name (resolved or fallback). */
  versions: Record<string, string>
  /** Packages set to `^<latest>` from the registry. */
  resolved: string[]
  /** Packages that kept their fallback range because the registry failed. */
  failed: string[]
  /** Third-party packages whose latest is a new major — fallback kept. */
  heldBack: HeldBackVersion[]
  /**
   * Third-party packages whose latest may be younger than the release-age
   * window (pnpm `minimumReleaseAge`) — fallback kept so installs stay possible.
   */
  tooFresh: FreshVersion[]
  /** Registry actually queried. */
  registry: string
}

export interface ResolveLatestOptions {
  /** Injectable fetch (tests). Default: the global fetch. */
  fetch?: typeof globalThis.fetch
  /** Registry base URL. Default: `npm_config_registry`, else the public npm registry. */
  registry?: string
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number
  /** Cap on the whole resolution in ms. Default 15000. */
  overallTimeoutMs?: number
  /** Requests in flight at once. Default 8. */
  concurrency?: number
  /**
   * Release-age window in minutes (pnpm `minimumReleaseAge`): a third-party
   * latest not provably older than this keeps its fallback range. Default:
   * `pnpm_config_minimum_release_age` / `npm_config_minimum_release_age`, else
   * 1440 (pnpm 11's default). `0` disables the check (no probe requests).
   */
  minimumReleaseAge?: number
  /** Clock used when the registry sends no `Date` header (tests). Default: Date.now. */
  now?: () => number
}

/**
 * The release-age window in minutes: an explicit option, else the pnpm/npm
 * config env var (a `pnpm create` exports its config), else pnpm 11's default.
 */
export function minimumReleaseAgeMinutes(explicit?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit
  for (const key of ['pnpm_config_minimum_release_age', 'npm_config_minimum_release_age']) {
    const raw = env[key]
    if (raw !== undefined && /^\d+$/.test(raw.trim())) return Number(raw.trim())
  }
  return DEFAULT_MINIMUM_RELEASE_AGE_MINUTES
}

/**
 * The registry to query: an explicit option, else `npm_config_registry` (npm
 * and pnpm export it to `create` binaries, so a private mirror is honored),
 * else the public registry. Trailing slashes are normalized; anything that is
 * not an http(s) URL falls back to the default.
 */
export function registryUrl(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const candidate = explicit ?? env['npm_config_registry'] ?? env['NPM_CONFIG_REGISTRY']
  if (!candidate) return DEFAULT_REGISTRY
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_REGISTRY
  } catch {
    return DEFAULT_REGISTRY
  }
  let end = candidate.length
  while (end > 0 && candidate[end - 1] === '/') end--
  return candidate.slice(0, end)
}

/** `<registry>/<name>/latest`, with a scoped name's `/` encoded as `%2f`. */
export const latestUrl = (registry: string, name: string): string =>
  `${registry}/${name.replaceAll('/', '%2f')}/latest`

/** `<registry>/<name>` — the packument (probed with HEAD for its `last-modified`). */
export const packumentUrl = (registry: string, name: string): string =>
  `${registry}/${name.replaceAll('/', '%2f')}`

/**
 * Whether `name`'s latest is provably older than `windowMs`. A packument's
 * `last-modified` is never older than its latest publish, so an old header
 * proves maturity. Age is measured against the registry's own `Date` header
 * when present (immune to local clock skew). Never throws.
 */
async function probeAge(
  fetchImpl: typeof globalThis.fetch,
  registry: string,
  name: string,
  windowMs: number,
  now: () => number,
  signal: AbortSignal,
): Promise<'mature' | 'recent' | 'unknown'> {
  try {
    const response = await fetchImpl(packumentUrl(registry, name), {
      method: 'HEAD',
      headers: { accept: ABBREVIATED_METADATA },
      signal,
    })
    if (!response.ok) return 'unknown'
    const modified = Date.parse(response.headers.get('last-modified') ?? '')
    if (Number.isNaN(modified)) return 'unknown'
    const serverNow = Date.parse(response.headers.get('date') ?? '')
    const reference = Number.isNaN(serverNow) ? now() : serverNow
    return reference - modified >= windowMs ? 'mature' : 'recent'
  } catch {
    return 'unknown'
  }
}

/** Outcome of one registry lookup: a version, a definitive miss, or a transient failure. */
type Lookup = { version: string } | 'miss' | 'transient'

async function lookupLatest(
  fetchImpl: typeof globalThis.fetch,
  registry: string,
  name: string,
  signal: AbortSignal,
): Promise<Lookup> {
  try {
    const response = await fetchImpl(latestUrl(registry, name), {
      headers: { accept: 'application/json' },
      signal,
    })
    if (response.status >= 500 || response.status === 429) return 'transient'
    if (!response.ok) return 'miss'
    const body = (await response.json()) as { version?: unknown } | null
    const version = body?.version
    return typeof version === 'string' && STABLE_SEMVER.test(version) ? { version } : 'miss'
  } catch {
    // Network error, per-request timeout, or malformed JSON.
    return 'transient'
  }
}

/**
 * The latest stable version of `name`, or undefined. A transient failure
 * (network error, timeout, 5xx/429) is retried once — on slow links the first
 * wave of cold TLS handshakes is the part that times out, and the retry rides
 * a warm keep-alive connection. The overall signal bounds both attempts.
 */
async function fetchLatest(
  fetchImpl: typeof globalThis.fetch,
  registry: string,
  name: string,
  timeoutMs: number,
  overall: AbortSignal,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2 && !overall.aborted; attempt++) {
    const result = await lookupLatest(
      fetchImpl,
      registry,
      name,
      AbortSignal.any([AbortSignal.timeout(timeoutMs), overall]),
    )
    if (result === 'miss') return undefined
    if (result !== 'transient') return result.version
  }
  return undefined
}

/**
 * Resolves the latest published version of every package in `fallbacks`
 * (name → fallback range) through a small pool of parallel requests. Never throws: a package the registry
 * cannot answer for keeps its fallback range and is listed in `failed`.
 */
export async function resolveLatestVersions(
  fallbacks: Readonly<Record<string, string>>,
  options: ResolveLatestOptions = {},
): Promise<VersionResolution> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const registry = registryUrl(options.registry)
  const versions: Record<string, string> = { ...fallbacks }
  const resolved: string[] = []
  const failed: string[] = []
  const heldBack: HeldBackVersion[] = []
  const tooFresh: FreshVersion[] = []
  const names = Object.keys(fallbacks).sort()
  const windowMs = minimumReleaseAgeMinutes(options.minimumReleaseAge) * 60_000
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? PER_REQUEST_TIMEOUT_MS

  if (typeof fetchImpl !== 'function') {
    return { versions, resolved, failed: names, heldBack, tooFresh, registry }
  }

  /** A third-party latest on the template-compatible major (else undefined). */
  const compatible = (name: string, version: string): boolean => {
    if (alwaysLatest(name)) return true
    const major = compatibleMajor(fallbacks[name] as string)
    return major !== undefined && Number(version.split('.')[0]) === major
  }

  const overall = new AbortController()
  const cap = setTimeout(() => overall.abort(), options.overallTimeoutMs ?? OVERALL_TIMEOUT_MS)
  try {
    const latest: (string | undefined)[] = []
    const age: ('mature' | 'recent' | 'unknown')[] = []
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < names.length) {
        const i = next++
        const name = names[i] as string
        const version = await fetchLatest(fetchImpl, registry, name, timeoutMs, overall.signal)
        latest[i] = version
        age[i] =
          version === undefined || alwaysLatest(name) || windowMs === 0 || !compatible(name, version)
            ? 'mature'
            : await probeAge(
                fetchImpl,
                registry,
                name,
                windowMs,
                now,
                AbortSignal.any([AbortSignal.timeout(timeoutMs), overall.signal]),
              )
      }
    }
    const pool = Math.max(1, Math.min(options.concurrency ?? CONCURRENCY, names.length))
    await Promise.all(Array.from({ length: pool }, worker))
    names.forEach((name, i) => {
      const version = latest[i]
      const fallback = fallbacks[name] as string
      if (version === undefined) {
        failed.push(name)
        return
      }
      if (!compatible(name, version)) {
        heldBack.push({ name, latest: version, range: fallback })
        return
      }
      const verdict = age[i]
      if (verdict === 'recent' || verdict === 'unknown') {
        tooFresh.push({ name, latest: version, range: fallback, reason: verdict })
        return
      }
      versions[name] = `^${version}`
      resolved.push(name)
    })
  } finally {
    clearTimeout(cap)
  }
  return { versions, resolved, failed, heldBack, tooFresh, registry }
}

/**
 * Rewrites the dependency ranges of a generated package.json with the
 * resolved versions (keys, order and every other field untouched).
 */
export function applyVersions(packageJsonText: string, versions: Readonly<Record<string, string>>): string {
  const pkg = JSON.parse(packageJsonText) as Record<string, unknown>
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field] as Record<string, string> | undefined
    if (!deps) continue
    for (const name of Object.keys(deps)) {
      const range = versions[name]
      if (range !== undefined) deps[name] = range
    }
  }
  return `${JSON.stringify(pkg, null, 2)}\n`
}

/** Every dependency/devDependency name → range declared in the given package.json texts. */
export function collectDependencies(packageJsonTexts: readonly string[]): Record<string, string> {
  const all: Record<string, string> = {}
  for (const text of packageJsonTexts) {
    const pkg = JSON.parse(text) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
    Object.assign(all, pkg.dependencies, pkg.devDependencies)
  }
  return all
}

/** Human-readable lines summarizing a resolution (for the CLI). */
export function describeResolution(resolution: VersionResolution): string[] {
  const lines: string[] = []
  if (resolution.resolved.length > 0) {
    lines.push(
      `Resolved ${resolution.resolved.length} dependencies to their latest published versions:`,
      `  ${resolution.resolved.map((name) => `${name}@${resolution.versions[name]}`).join(', ')}`,
    )
  }
  for (const held of resolution.heldBack) {
    lines.push(
      `Note: ${held.name} ${held.latest} is a new major this template does not target yet — kept ${held.range}.`,
    )
  }
  const recent = resolution.tooFresh.filter((entry) => entry.reason === 'recent')
  const unknown = resolution.tooFresh.filter((entry) => entry.reason === 'unknown')
  for (const fresh of recent) {
    lines.push(
      `Note: ${fresh.name} ${fresh.latest} was published inside pnpm's minimumReleaseAge window — kept ${fresh.range} (pnpm installs the newest mature version).`,
    )
  }
  if (unknown.length > 0) {
    lines.push(
      `Note: could not prove the release age of ${unknown.map((entry) => `${entry.name}@${entry.latest}`).join(', ')} — kept the bundled range(s) so minimumReleaseAge cannot block the install.`,
    )
  }
  if (resolution.failed.length > 0) {
    lines.push(
      `Warning: could not reach ${resolution.registry} for ${resolution.failed.length} package(s) — used the bundled fallback ranges for: ${resolution.failed.join(', ')}.`,
    )
  }
  return lines
}
