import { describe, expect, it } from 'vitest'
import { isBranchName, validateConfig } from '../src/config.js'
import { gitTarget, preflight } from '../src/pipeline.js'
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
