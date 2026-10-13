import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isBranchName, validateConfig } from '../src/config.js'
import { fetchArgs, gitTarget, preflight } from '../src/pipeline.js'
import { acmeConfig, context, FakeHost, ok } from './fake-host.js'

describe('branch and remote names (git option injection)', () => {
  it('accepts the names a deploy tracks', () => {
    for (const name of ['main', 'master', 'release/1.2', 'feat/x_y-z', 'v1.2.3', 'hotfix+1']) expect(isBranchName(name), name).toBe(true)
  })

  it('refuses anything git would read as an option, or that check-ref-format refuses', () => {
    for (const name of [
      '--upload-pack=touch /tmp/x;', '-x', '', '/main', 'main/', 'a..b', 'a//b', 'a/.b', '.hidden', 'main.', 'main.lock',
      'a.lock/b', 'a b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', '@{-1}', 'x'.repeat(201),
    ]) expect(isBranchName(name), name).toBe(false)
  })

  it('validateConfig names both problems', () => {
    expect(() => validateConfig(acmeConfig({ branch: '--upload-pack=touch /tmp/x;' }))).toThrow(/branch "--upload-pack=touch \/tmp\/x;" is not a plain git branch name/)
    expect(() => validateConfig(acmeConfig({ remote: '-oProxyCommand=x' }))).toThrow(/remote "-oProxyCommand=x" is not a git remote name/)
    expect(() => validateConfig(acmeConfig({ remote: 'https://example.com/x.git' }))).toThrow(/remote/)
  })

  it('the pipeline refuses an unvalidated config before git runs', async () => {
    const host = new FakeHost().on(({ command }) => (command === 'git' ? ok('') : undefined))
    const ctx = context(host, acmeConfig({ branch: '--upload-pack=touch /tmp/x;' }))
    expect(() => gitTarget(ctx)).toThrow(/not a plain git branch name/)
    await expect(preflight(ctx)).rejects.toThrow(/not a plain git branch name/)
    expect(host.commands('git').some((c) => c.includes('upload-pack'))).toBe(false)
  })

  it('probes the remote with explicit refs after "--"', async () => {
    const host = new FakeHost().on(({ command }) => (command === 'git' ? ok('') : undefined))
    const ctx = context(host, acmeConfig({ branch: 'release/1.2', remote: 'upstream' }))
    expect(gitTarget(ctx)).toEqual({ remote: 'upstream', branch: 'release/1.2', head: 'refs/heads/release/1.2', tracking: 'refs/remotes/upstream/release/1.2' })
    await preflight(ctx).catch(() => undefined)
    expect(host.commands('git')).toContain('git ls-remote --exit-code -- upstream refs/heads/release/1.2')
  })
})

describe('the fetch, on a real git', () => {
  it('reaches a branch rewritten upstream after a rollback; the ff-only merge still guards the checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'basalt-deploy-fetch-'))
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    try {
      const remote = join(root, 'remote.git')
      const work = join(root, 'work')
      const server = join(root, 'server')
      git(root, 'init', '--bare', '--quiet', remote)
      git(root, 'clone', '--quiet', remote, work)
      const commit = async (message: string) => { await writeFile(join(work, 'f'), message); git(work, 'add', 'f'); git(work, 'commit', '--quiet', '-m', message) }
      await commit('OLD')
      git(work, 'push', '--quiet', 'origin', 'HEAD:main')
      git(root, 'clone', '--quiet', remote, server)
      await commit('BAD')
      git(work, 'push', '--quiet', 'origin', 'HEAD:main')
      const target = { remote: 'origin', head: 'refs/heads/main', tracking: 'refs/remotes/origin/main' }
      git(server, ...fetchArgs(target))
      git(server, 'merge', '--ff-only', '--quiet', target.tracking)
      // A rollback on the server; upstream drops BAD and commits the fix.
      git(server, 'reset', '--hard', '--quiet', 'HEAD~1')
      git(work, 'reset', '--hard', '--quiet', 'HEAD~1')
      await commit('FIX')
      git(work, 'push', '--quiet', '--force', 'origin', 'HEAD:main')
      // The unforced refspec is refused (non-fast-forward) — what every run hit.
      expect(spawnSync('git', ['fetch', '--quiet', '--', 'origin', `${target.head}:${target.tracking}`], { cwd: server }).status).not.toBe(0)
      git(server, ...fetchArgs(target))
      git(server, 'merge', '--ff-only', '--quiet', target.tracking)
      expect(git(server, 'log', '-1', '--format=%s')).toBe('FIX')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
