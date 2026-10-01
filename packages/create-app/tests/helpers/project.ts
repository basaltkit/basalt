import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ProjectCommandDeps } from '../../src/project/run.js'

/**
 * Test doubles for the project commands: a fake npm registry (`/latest` +
 * the release-age HEAD probe), a recording package-manager runner, captured
 * output. Nothing here touches the network or installs anything.
 */

/** A `last-modified` far outside any release-age window. */
export const LONG_AGO = 'Mon, 01 Jan 2024 00:00:00 GMT'
export const NOW = Date.parse('2026-10-01T12:00:00Z')
export const hoursAgo = (hours: number): string => new Date(NOW - hours * 3_600_000).toUTCString()

export interface FakePackage {
  version: string
  peerDependencies?: Record<string, string>
  /** `last-modified` of the packument (default: long ago). */
  modified?: string
}

export function fakeRegistry(packages: Record<string, FakePackage | 'down'>, calls: string[] = []): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(init?.method === 'HEAD' ? `HEAD ${url}` : url)
    if (init?.method === 'HEAD') {
      const name = decodeURIComponent(/\/((?:@[^/]+%2f)?[^/]+)$/.exec(url)?.[1] ?? '')
      const entry = packages[name]
      const modified = entry && entry !== 'down' ? (entry.modified ?? LONG_AGO) : LONG_AGO
      return new Response(null, { status: 200, headers: { 'last-modified': modified, date: new Date(NOW).toUTCString() } })
    }
    const name = decodeURIComponent(/\/((?:@[^/]+%2f)?[^/]+)\/latest$/.exec(url)?.[1] ?? '')
    const entry = packages[name]
    if (entry === 'down') throw new TypeError('fetch failed')
    if (entry === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify({ name, version: entry.version, peerDependencies: entry.peerDependencies ?? {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
}

/** A registry where every package is down (network failure). */
export const offlineFetch: typeof globalThis.fetch = (async () => {
  throw new TypeError('fetch failed')
}) as typeof globalThis.fetch

export interface Harness {
  deps: ProjectCommandDeps
  stdout: string[]
  stderr: string[]
  runs: { command: string; args: string[]; cwd: string }[]
  codemodRuns: string[]
  /** All output (stdout + stderr) as one string. */
  output(): string
}

export function harness(
  cwd: string,
  options: {
    fetch?: typeof globalThis.fetch
    installOk?: boolean
    interactive?: boolean
    confirm?: boolean
    env?: NodeJS.ProcessEnv
    nodeVersion?: string
    minimumReleaseAge?: number
  } = {},
): Harness {
  const stdout: string[] = []
  const stderr: string[] = []
  const runs: Harness['runs'] = []
  const codemodRuns: string[] = []
  const deps: ProjectCommandDeps = {
    cwd,
    out: { log: (line = '') => stdout.push(line), error: (line) => stderr.push(line) },
    env: options.env ?? { NO_COLOR: '1' },
    interactive: options.interactive ?? false,
    isTTY: false,
    registry: {
      fetch: options.fetch ?? offlineFetch,
      registry: 'https://registry.test',
      now: () => NOW,
      ...(options.minimumReleaseAge !== undefined ? { minimumReleaseAge: options.minimumReleaseAge } : {}),
    },
    run: async (command, args, dir) => {
      runs.push({ command, args, cwd: dir })
      return options.installOk ?? true
    },
    capture: async () => '11.8.0',
    confirm: async () => options.confirm ?? true,
    codemods: async (dir) => {
      codemodRuns.push(dir)
    },
    nodeVersion: options.nodeVersion ?? '24.1.0',
  }
  return { deps, stdout, stderr, runs, codemodRuns, output: () => [...stdout, ...stderr].join('\n') }
}

export const read = (dir: string, path: string): Promise<string> => readFile(join(dir, path), 'utf8')

export async function write(dir: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(dir, path)), { recursive: true })
  await writeFile(join(dir, path), content)
}

/** Fakes an installed package under `<dir>/node_modules`. */
export async function install(
  dir: string,
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await write(dir, join('node_modules', ...name.split('/'), 'package.json'), JSON.stringify({ name, version, ...extra }))
}
