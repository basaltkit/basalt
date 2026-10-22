import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanText, commitRange, commitSubjects, incomingCommits, MAX_SUBJECT, parseLog, PREVIEW_REF } from '../src/commits.js'
import type { DeployContext } from '../src/context.js'
import { nodeHost, type Output } from '../src/host.js'
import { commitsCommand, describeCommits } from '../src/pipeline.js'
import type { Commits, CommitsResult, Release, ResultCommand, ResultPayloads } from '../src/protocol.js'
import { rollbackTarget } from '../src/state.js'
import { acmeConfig, context, FakeHost, fail, ok } from './fake-host.js'

const quiet: Output = { step() {}, info() {}, ok() {}, warn() {}, error() {} }
let root: string
let remote: string
let work: string
let server: string
let tick = 0

/** git with a fixed identity and no signing, whatever the developer's config says. */
function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env },
  }).trim()
}

/** A commit in `cwd`, a second apart from the last one (stable topo order). */
async function commit(cwd: string, subject: string, author = 'Dev'): Promise<string> {
  tick++
  const date = `2026-10-01T10:00:${String(tick % 60).padStart(2, '0')}+00:00`
  await writeFile(join(cwd, `f-${tick}`), subject.slice(0, 100))
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '--quiet', '-m', subject], { GIT_AUTHOR_NAME: author, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
  return git(cwd, ['rev-parse', 'HEAD'])
}

const head = (cwd: string) => git(cwd, ['rev-parse', 'HEAD'])
const ctxAt = (dir: string, output: Output = quiet): DeployContext => ({
  config: acmeConfig(), dir, host: nodeHost(output), pm: 'pnpm', envPath: join(dir, '.env'), stateDir: join(dir, '.basalt'),
})
const target = { remote: 'origin', head: 'refs/heads/main' }
const range = (commits: Commits) => {
  if (!commits.ok) throw new Error(`unavailable: ${commits.reason}`)
  return commits.range
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'basalt-deploy-commits-'))
  remote = join(root, 'remote.git')
  work = join(root, 'work')
  server = join(root, 'server')
  git(root, ['init', '--bare', '--quiet', remote])
  git(root, ['clone', '--quiet', remote, work])
  await commit(work, 'first')
  git(work, ['push', '--quiet', 'origin', 'HEAD:main'])
  git(root, ['clone', '--quiet', remote, server])
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('commitRange, on a real git', () => {
  it('a fast-forward: what goes out, newest first; the plan fetch leaves the tracking ref and no preview ref', async () => {
    const b = await commit(work, 'add invoices')
    const c = await commit(work, 'fix totals', 'Ana')
    git(work, ['push', '--quiet', 'origin', 'HEAD:main'])
    const tracking = git(server, ['rev-parse', 'refs/remotes/origin/main'])

    const r = range(await incomingCommits(ctxAt(server), target, false))
    expect(r).toMatchObject({ from: head(server), to: c, relation: 'ahead', addedTotal: 2, removedTotal: 0, removed: [], truncated: false })
    expect(r.added.map((x) => [x.sha, x.subject, x.author])).toEqual([[c, 'fix totals', 'Ana'], [b, 'add invoices', 'Dev']])
    expect(r.added[0]?.at).toMatch(/^2026-10-01T10:00:\d\d(?:Z|\+00:00)$/)
    // run's ref, HEAD and the worktree are as they were; the preview ref is gone.
    expect(git(server, ['rev-parse', 'refs/remotes/origin/main'])).toBe(tracking)
    expect(git(server, ['for-each-ref', '--format=%(refname)', 'refs/basalt-deploy/'])).toBe('')
    expect(git(server, ['status', '--porcelain'])).toBe('')
  })

  it('nothing new: same', async () => {
    const r = range(await incomingCommits(ctxAt(server), target, false))
    expect(r).toMatchObject({ relation: 'same', added: [], removed: [], addedTotal: 0, removedTotal: 0 })
    expect(describeCommits({ ok: true, range: r })).toMatch(/^commits: nothing new/)
  })

  it('a branch rewritten upstream (force-push): both what comes and what only the server has', async () => {
    const bad = await commit(work, 'BAD')
    git(work, ['push', '--quiet', 'origin', 'HEAD:main'])
    git(server, ['pull', '--quiet', '--ff-only'])
    git(work, ['reset', '--hard', '--quiet', 'HEAD~1'])
    const fix = await commit(work, 'FIX')
    git(work, ['push', '--quiet', '--force', 'origin', 'HEAD:main'])

    const r = range(await incomingCommits(ctxAt(server), target, false))
    expect(r.relation).toBe('diverged')
    expect(r.added.map((x) => x.sha)).toEqual([fix])
    expect(r.removed.map((x) => x.sha)).toEqual([bad])
    expect(r.mergeBase).toBe(git(work, ['rev-parse', 'HEAD~1']))
    expect(describeCommits({ ok: true, range: r })).toMatch(/rewritten .* run refuses it/)
  })

  it('a merge: the commits it brings in go out too (no --first-parent), the merge is marked', async () => {
    const from = head(work)
    git(work, ['checkout', '--quiet', '-b', 'feature'])
    const f1 = await commit(work, 'feature one')
    const f2 = await commit(work, 'feature two')
    git(work, ['checkout', '--quiet', 'main'])
    const m1 = await commit(work, 'main work')
    git(work, ['merge', '--no-ff', '--quiet', '-m', 'Merge feature', 'feature'])
    const merge = head(work)

    const r = range(await commitRange(ctxAt(work), from, merge))
    expect(r.relation).toBe('ahead')
    expect(r.addedTotal).toBe(4)
    expect(new Set(r.added.map((x) => x.sha))).toEqual(new Set([merge, f1, f2, m1]))
    expect(r.added.find((x) => x.sha === merge)?.merge).toBe(true)
    expect(r.added.filter((x) => x.merge)).toHaveLength(1)
    // Back again: a rollback over the merge takes all four out.
    const back = range(await commitRange(ctxAt(work), merge, from))
    expect(back).toMatchObject({ relation: 'behind', removedTotal: 4, addedTotal: 0 })
  })

  it('caps each list at 50, with the true total and truncated', async () => {
    const from = head(work)
    for (let i = 0; i < 60; i++) await commit(work, `change ${i}`)
    const r = range(await commitRange(ctxAt(work), from, head(work)))
    expect(r.added).toHaveLength(50)
    expect(r.addedTotal).toBe(60)
    expect(r.truncated).toBe(true)
    expect(r.added[0]?.subject).toBe('change 59')
  })

  it('unavailable, never a throw: a missing commit, unrelated histories, a shallow clone', async () => {
    const current = head(server)
    expect(await commitRange(ctxAt(server), current, 'f'.repeat(40))).toEqual({ ok: false, reason: 'missing-commit' })
    git(server, ['checkout', '--quiet', '--orphan', 'other'])
    const orphan = await commit(server, 'unrelated root')
    expect(await commitRange(ctxAt(server), current, orphan)).toEqual({ ok: false, reason: 'unrelated' })
    expect(await commitRange(ctxAt(server), 'HEAD', current)).toEqual({ ok: false, reason: 'malformed' })

    await commit(work, 'second')
    git(work, ['push', '--quiet', 'origin', 'HEAD:main'])
    const shallow = join(root, 'shallow')
    git(root, ['clone', '--quiet', '--depth=1', `file://${remote}`, shallow])
    expect(await commitRange(ctxAt(shallow), current, head(shallow))).toEqual({ ok: false, reason: 'shallow' })
  })

  it('a remote it cannot reach, or --skip=fetch: unavailable', async () => {
    git(server, ['remote', 'set-url', 'origin', join(root, 'gone.git')])
    expect(await incomingCommits(ctxAt(server), target, false)).toEqual({ ok: false, reason: 'not-fetched' })
    expect(await incomingCommits(ctxAt(server), target, true)).toEqual({ ok: false, reason: 'skipped' })
  })

  it('the author\'s text is data: escapes, controls, bidi and length are taken out on the server', async () => {
    const from = head(work)
    const hostile = `\u001b[31mred\u001b[0m \u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 ‮evil‬ <script>alert(1)</script> ${'x'.repeat(10_000)}`
    await commit(work, hostile, '\u001b[2JMallory‮')
    const [c] = range(await commitRange(ctxAt(work), from, head(work))).added
    expect(c?.subject).not.toMatch(/[\u001b‮‬\u0007]/)
    expect(c?.subject.startsWith('red link evil <script>alert(1)</script> xxx')).toBe(true)
    expect([...(c?.subject ?? '')]).toHaveLength(MAX_SUBJECT)
    expect(c?.author).toMatch(/Mallory$/)
    expect(c?.author).not.toMatch(/[\u001b\u202e]/)
  })

  it('subjects of the releases, in one call; a missing one is left out', async () => {
    const current = head(server)
    expect(await commitSubjects(ctxAt(server), [current, 'e'.repeat(40), 'not-a-sha'])).toEqual({ [current]: 'first' })
    expect(await commitSubjects(ctxAt(server), [])).toEqual({})
  })
})

describe('commits command', () => {
  async function result(dir: string, request: Parameters<typeof commitsCommand>[1], releases?: Release[]): Promise<CommitsResult> {
    let got: CommitsResult | undefined
    const output: Output = { ...quiet, result<C extends ResultCommand>(_: C, data: ResultPayloads[C]) { got = data as CommitsResult } }
    const ctx = ctxAt(dir, output)
    if (releases) {
      await mkdir(ctx.stateDir, { recursive: true })
      await writeFile(join(ctx.stateDir, 'releases.json'), JSON.stringify(releases))
    }
    expect(await commitsCommand(ctx, request)).toBe(0)
    return got as CommitsResult
  }
  const release = (sha: string, status: Release['status'] = 'ok', previous?: string): Release => ({ sha, at: '2026-10-01T10:00:00.000Z', user: 'deployer', status, migrations: [], ...(previous ? { previous } : {}) })

  it('--rollback with no history: no-previous, and the command still succeeds', async () => {
    expect(await result(server, { rollback: true })).toMatchObject({ purpose: 'rollback', from: head(server), commits: { ok: false, reason: 'no-previous' } })
  })

  it('--rollback previews what leaves production, to the target rollback itself would choose', async () => {
    const a = head(server)
    const b = await commit(server, 'b')
    const c = await commit(server, 'c broke it')
    const got = await result(server, { rollback: true }, [release(a), release(b, 'ok', a), release(c, 'ok', b)])
    expect(got).toMatchObject({ purpose: 'rollback', from: c, to: b })
    expect(range(got.commits)).toMatchObject({ relation: 'behind', removedTotal: 1, addedTotal: 0 })
    expect(range(got.commits).removed[0]?.subject).toBe('c broke it')
    // --to: further back.
    const further = await result(server, { rollback: true, to: a.slice(0, 7) }, [release(a), release(b, 'ok', a), release(c, 'ok', b)])
    expect(further).toMatchObject({ to: a })
    expect(range(further.commits).removedTotal).toBe(2)
    expect((await result(server, { rollback: true, to: 'abcdef1' })).commits).toEqual({ ok: false, reason: 'missing-commit' })
  })

  it('--from/--to: the commits between two releases', async () => {
    const a = head(server)
    const b = await commit(server, 'b')
    expect(range((await result(server, { from: a.slice(0, 7), to: b })).commits).added.map((x) => x.subject)).toEqual(['b'])
    expect((await result(server, { from: 'abcdef1', to: b })).commits).toEqual({ ok: false, reason: 'missing-commit' })
  })
})

describe('git failures, on a fake git', () => {
  const sha1 = '1'.repeat(40)
  const sha2 = '2'.repeat(40)
  const answering = (log: (args: string[]) => ReturnType<typeof ok>) => new FakeHost().on(({ command, args }) => {
    if (command !== 'git') return undefined
    const verb = args.find((a) => !a.startsWith('-') && !a.includes('='))
    if (verb === 'rev-parse') return ok('false')
    if (verb === 'cat-file') return ok()
    if (verb === 'merge-base') return ok(sha1)
    if (verb === 'rev-list') return ok('0\t1')
    return log(args)
  })

  it('git fails, hangs or prints too much: the reason, never git\'s text', async () => {
    for (const [answer, reason] of [
      [fail('fatal: could not read from https://user:token@example.com', 128), 'git-failed'],
      [{ ...fail('', 1), limit: 'timeout' as const }, 'timeout'],
      [{ ...fail('', 1), limit: 'too-large' as const }, 'too-large'],
    ] as const) {
      const host = answering(() => answer)
      expect(await commitRange(context(host), sha1, sha2)).toEqual({ ok: false, reason })
    }
    const throwing = new FakeHost().on(() => { throw new Error('spawn git ENOENT') })
    expect(await commitRange(context(throwing), sha1, sha2)).toEqual({ ok: false, reason: 'git-failed' })
  })

  it('output that does not frame as commits: malformed, the whole list', async () => {
    const host = answering(() => ok(`${sha2}\u0000\u0000Dev\u00002026-10-01T10:00:00+00:00\u0000subject\u0000extra\u0000`))
    expect(await commitRange(context(host), sha1, sha2)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('passes limits to every git call and never a pager', async () => {
    const host = answering(() => ok(`${sha2}\u0000${sha1}\u0000Dev\u00002026-10-01T10:00:00+00:00\u0000subject\u0000`))
    expect((await commitRange(context(host), sha1, sha2)).ok).toBe(true)
    for (const call of host.calls) {
      expect(call.options.timeoutMs).toBeGreaterThan(0)
      expect(call.options.maxOutputBytes).toBeGreaterThan(0)
      expect(call.args.slice(0, 2)).toEqual(['-c', 'core.pager=cat'])
    }
  })

  it('the plan fetch never names the tracking ref, and deletes its preview ref even when the fetch fails', async () => {
    const host = new FakeHost().on(({ command, args }) => {
      if (command !== 'git') return undefined
      if (args.includes('fetch')) return fail('fatal: unable to access', 128)
      if (args.includes('rev-parse')) return ok(sha1)
      return ok()
    })
    expect(await incomingCommits(context(host), target, false)).toEqual({ ok: false, reason: 'not-fetched' })
    const fetch = host.calls.find((c) => c.args.includes('fetch'))
    expect(fetch?.args).toContain('--refmap=')
    expect(fetch?.args.at(-1)).toBe(`+refs/heads/main:${PREVIEW_REF}`)
    expect(host.calls.some((c) => c.args.includes('update-ref') && c.args.includes(PREVIEW_REF))).toBe(true)
  })
})

describe('parsing and cleaning', () => {
  const sha = 'a'.repeat(40)
  it('a forged date drops only that date', () => {
    expect(parseLog(`${sha}\u0000\u0000Dev\u0000not-a-date\u0000subject\u0000`)).toEqual([{ sha, subject: 'subject', author: 'Dev' }])
  })
  it('a bad sha or parent refuses the whole list', () => {
    expect(parseLog(`zz\u0000\u0000Dev\u0000\u0000s\u0000`)).toBeUndefined()
    expect(parseLog(`${sha}\u0000HEAD\u0000Dev\u0000\u0000s\u0000`)).toBeUndefined()
  })
  it('cleanText caps by characters, not bytes, and keeps no newline', () => {
    expect(cleanText('a\nb\r\tc', 10)).toBe('ab\tc')
    expect([...cleanText('é'.repeat(300), 200)]).toHaveLength(200)
  })
})

describe('rollbackTarget', () => {
  const r = (sha: string, status: Release['status'] = 'ok', previous?: string): Release => ({ sha, at: '', user: '', status, migrations: [], ...(previous ? { previous } : {}) })
  it('the asked commit, else the last healthy one, else what current was deployed over', () => {
    expect(rollbackTarget([r('a'), r('b'), r('c')], 'c', 'x')).toBe('x')
    expect(rollbackTarget([r('a'), r('b'), r('c')], 'c')).toBe('b')
    expect(rollbackTarget([r('a'), r('b', 'rollback-unhealthy'), r('c')], 'c')).toBe('a')
    expect(rollbackTarget([r('c', 'ok', 'p')], 'c')).toBe('p')
    expect(rollbackTarget([], 'c')).toBeUndefined()
  })
})
