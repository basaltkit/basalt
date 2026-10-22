import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { describeRemoteUrl, remoteSource } from '../src/commits.js'
import type { DeployContext } from '../src/context.js'
import { nodeHost, type Output } from '../src/host.js'
import { acmeConfig, context, FakeHost, ok } from './fake-host.js'

/**
 * `status` says which app a target really is: the config's remote and
 * branch, and where that remote points — as host and path, never with a
 * credential, a query or a path of the server.
 */

describe('describeRemoteUrl', () => {
  it('keeps host and path; drops the scheme, credentials, query, fragment and .git', () => {
    expect(describeRemoteUrl('https://github.com/acme/app.git')).toBe('github.com/acme/app')
    expect(describeRemoteUrl('https://x-access-token:ghp_secret@github.com/acme/app.git\n')).toBe('github.com/acme/app')
    expect(describeRemoteUrl('https://alice:hunter2@git.example.com:8443/team/app/?token=abc#frag')).toBe('git.example.com:8443/team/app')
    expect(describeRemoteUrl('ssh://git@git.example.com:2222/acme/app.git')).toBe('git.example.com:2222/acme/app')
    expect(describeRemoteUrl('git@github.com:acme/app.git')).toBe('github.com/acme/app')
    expect(describeRemoteUrl('deploy@git.example.com:repos/app')).toBe('git.example.com/repos/app')
  })

  it('says nothing for a local path, file://, other schemes, or text outside a plain host and path', () => {
    for (const raw of [
      '/srv/git/app.git', '../app.git', 'file:///srv/git/app.git', 'C:\\repos\\app', 'ext::sh -c touch% /tmp/x',
      'https://github.com/acme/app%20x', 'https://github.com/acme/<b>app</b>', 'https://github.com/acme/app\u202e', 'https://github.com/',
      `https://github.com/${'a/'.repeat(120)}app`, '', 'origin',
    ]) expect(describeRemoteUrl(raw), raw).toBeUndefined()
  })
})

describe('remoteSource', () => {
  let root: string
  const quiet: Output = { step() {}, info() {}, ok() {}, warn() {}, error() {} }
  const ctxAt = (dir: string): DeployContext => ({ config: acmeConfig(), dir, host: nodeHost(quiet), pm: 'pnpm', envPath: join(dir, '.env'), stateDir: join(dir, '.basalt') })
  const git = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'ignore' })

  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'basalt-deploy-source-')) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('reads the remote with real git and never passes its credentials on', async () => {
    git(root, ['init', '--quiet', '.'])
    git(root, ['remote', 'add', 'origin', 'https://deploy:s3cr3t@github.com/acme/app.git'])
    const source = await remoteSource(ctxAt(root), { remote: 'origin', branch: 'main' })
    expect(source).toEqual({ remote: 'origin', branch: 'main', url: 'github.com/acme/app' })
    expect(JSON.stringify(source)).not.toContain('s3cr3t')
  })

  it('a missing remote, a local one, or a git that fails: remote and branch without url, never a throw', async () => {
    git(root, ['init', '--quiet', '.'])
    expect(await remoteSource(ctxAt(root), { remote: 'upstream', branch: 'release' })).toEqual({ remote: 'upstream', branch: 'release' })
    git(root, ['remote', 'add', 'origin', '/srv/git/app.git'])
    expect(await remoteSource(ctxAt(root), { remote: 'origin', branch: 'main' })).toEqual({ remote: 'origin', branch: 'main' })
    const host = new FakeHost()
    host.on((call) => { if (call.command === 'git') throw new Error('spawn git ENOENT'); return undefined })
    expect(await remoteSource(context(host), { remote: 'origin', branch: 'main' })).toEqual({ remote: 'origin', branch: 'main' })
    const timedOut = new FakeHost()
    timedOut.on((call) => (call.command === 'git' ? { ...ok('https://github.com/acme/app.git'), limit: 'timeout' as const } : undefined))
    expect(await remoteSource(context(timedOut), { remote: 'origin', branch: 'main' })).toEqual({ remote: 'origin', branch: 'main' })
  })
})
