import type { DeployContext } from './context.js'
import { sanitize } from './events.js'
import type { ExecResult } from './host.js'
import { COMMITS_LIMIT, type CommitInfo, type Commits, type CommitsUnavailable } from './protocol.js'

/**
 * The commits between two releases, for the plan, the history and a rollback
 * (RFC 0008 §4.3). Read-only and best effort: every function here returns
 * "unavailable" with a reason instead of throwing, so a git that fails, hangs
 * or prints too much never stops a deploy, a plan or a status.
 *
 * The text of a commit is the author's: data, never instructions. It is
 * sanitised (escapes, controls, bidi) and capped here, and only ever rendered
 * as plain text. git's own messages are never passed on: they can carry a
 * remote URL with credentials.
 */

const FULL_SHA = /^[0-9a-f]{40}$/
/** `%aI`: strict ISO-8601 with an offset. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z)$/
const BIDI = /[؜‎‏‪-‮⁦-⁩]/g
export const MAX_SUBJECT = 200
export const MAX_AUTHOR = 100
/** Per git call: a list of 50 capped commits is far below this; a huge one is cut, never read. */
export const MAX_GIT_OUTPUT_BYTES = 256 * 1024
export const GIT_TIMEOUT_MS = 5_000
/** The plan's fetch reaches the network. */
export const FETCH_TIMEOUT_MS = 30_000
/** Where `plan` fetches the branch: never the tracking ref `run` merges from. Deleted after use. */
export const PREVIEW_REF = 'refs/basalt-deploy/preview'

/** No pager, colour, signature check, notes, mailmap or replace refs: the same plain output on every server. */
const GIT_CONFIG = ['-c', 'core.pager=cat', '-c', 'color.ui=false', '-c', 'log.showSignature=false', '-c', 'i18n.logOutputEncoding=UTF-8']
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' }
/** NUL between fields and (with `-z`) after each commit: no text of a commit can forge the framing. */
const FORMAT = '--format=%H%x00%P%x00%an%x00%aI%x00%s'
const LOG_FLAGS = ['--no-show-signature', '--no-notes', '--no-mailmap', '--no-decorate', '--no-color', '--topo-order', '-z', FORMAT]

type Git = { ok: true; stdout: string; code: number } | { ok: false; reason: CommitsUnavailable }

async function git(ctx: DeployContext, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<Git> {
  let result: ExecResult
  try {
    result = await ctx.host.exec('git', [...GIT_CONFIG, ...args], { cwd: ctx.dir, env: GIT_ENV, timeoutMs, maxOutputBytes: MAX_GIT_OUTPUT_BYTES })
  } catch {
    return { ok: false, reason: 'git-failed' }
  }
  if (result.limit) return { ok: false, reason: result.limit }
  return { ok: true, stdout: result.stdout, code: result.code }
}

/** One line of the author's text: no escapes, controls, newlines or bidi overrides, at most `max` characters. */
export function cleanText(text: string, max: number): string {
  const plain = sanitize(text).replace(BIDI, '').trim()
  const chars = [...plain]
  return chars.length <= max ? plain : `${chars.slice(0, max - 1).join('')}…`
}

/**
 * `git log -z` with {@link FORMAT}: five fields per commit. A bad sha or a
 * wrong field count is a parse that went wrong — the whole list is refused.
 * A bad date is the author's to forge: only that date is dropped.
 */
export function parseLog(stdout: string): CommitInfo[] | undefined {
  const fields = stdout.split('\u0000')
  if (fields.at(-1) === '') fields.pop()
  if (fields.length % 5 !== 0) return undefined
  const commits: CommitInfo[] = []
  for (let i = 0; i < fields.length; i += 5) {
    const [sha, parents, author, at, subject] = fields.slice(i, i + 5) as [string, string, string, string, string]
    const parentList = parents === '' ? [] : parents.split(' ')
    if (!FULL_SHA.test(sha) || !parentList.every((p) => FULL_SHA.test(p))) return undefined
    commits.push({
      sha,
      subject: cleanText(subject, MAX_SUBJECT),
      author: cleanText(author, MAX_AUTHOR),
      ...(ISO_DATE.test(at) ? { at } : {}),
      ...(parentList.length > 1 ? { merge: true as const } : {}),
    })
  }
  return commits
}

async function list(ctx: DeployContext, include: string, exclude: string): Promise<CommitInfo[] | CommitsUnavailable> {
  const out = await git(ctx, ['log', ...LOG_FLAGS, `--max-count=${COMMITS_LIMIT}`, '--end-of-options', include, `^${exclude}`, '--'])
  if (!out.ok) return out.reason
  if (out.code !== 0) return 'git-failed'
  return parseLog(out.stdout) ?? 'malformed'
}

/**
 * What changes when the code goes from `from` to `to` (both full shas). The
 * whole ancestry, never `--first-parent`: the commits a merge brings in go
 * out too. Two lists, so a rewritten branch shows what it drops as well.
 */
export async function commitRange(ctx: DeployContext, from: string, to: string): Promise<Commits> {
  const unavailable = (reason: CommitsUnavailable): Commits => ({ ok: false, reason })
  if (!FULL_SHA.test(from) || !FULL_SHA.test(to)) return unavailable('malformed')
  if (from === to) return { ok: true, range: { from, to, relation: 'same', mergeBase: from, added: [], addedTotal: 0, removed: [], removedTotal: 0, truncated: false } }
  // Below a shallow boundary the merge base and the counts are silently wrong.
  const shallow = await git(ctx, ['rev-parse', '--is-shallow-repository'])
  if (!shallow.ok) return unavailable(shallow.reason)
  if (shallow.code !== 0) return unavailable('git-failed')
  if (shallow.stdout.trim() === 'true') return unavailable('shallow')
  for (const sha of [from, to]) {
    const exists = await git(ctx, ['cat-file', '-e', `${sha}^{commit}`])
    if (!exists.ok) return unavailable(exists.reason)
    // A sha a force-push and a gc took away, or never fetched here.
    if (exists.code !== 0) return unavailable('missing-commit')
  }
  const base = await git(ctx, ['merge-base', from, to])
  if (!base.ok) return unavailable(base.reason)
  if (base.code === 1) return unavailable('unrelated')
  const mergeBase = base.stdout.trim()
  if (base.code !== 0 || !FULL_SHA.test(mergeBase)) return unavailable('git-failed')
  const counts = await git(ctx, ['rev-list', '--left-right', '--count', '--end-of-options', `${from}...${to}`, '--'])
  if (!counts.ok) return unavailable(counts.reason)
  const match = /^(\d+)\s+(\d+)$/.exec(counts.stdout.trim())
  if (counts.code !== 0 || !match) return unavailable('git-failed')
  const removedTotal = Number(match[1])
  const addedTotal = Number(match[2])
  const added = addedTotal > 0 ? await list(ctx, to, from) : []
  if (typeof added === 'string') return unavailable(added)
  const removed = removedTotal > 0 ? await list(ctx, from, to) : []
  if (typeof removed === 'string') return unavailable(removed)
  const relation = addedTotal > 0 && removedTotal > 0 ? 'diverged' : addedTotal > 0 ? 'ahead' : removedTotal > 0 ? 'behind' : 'same'
  return {
    ok: true,
    range: { from, to, relation, mergeBase, added, addedTotal, removed, removedTotal, truncated: added.length < addedTotal || removed.length < removedTotal },
  }
}

/** The subject of each commit, by sha, in one git call; undefined when git could not say. Missing commits are left out. */
export async function commitSubjects(ctx: DeployContext, shas: string[]): Promise<Record<string, string> | undefined> {
  const wanted = [...new Set(shas.filter((sha) => FULL_SHA.test(sha)))]
  if (wanted.length === 0) return {}
  const out = await git(ctx, ['log', '--no-walk=unsorted', '--ignore-missing', ...LOG_FLAGS, '--end-of-options', ...wanted, '--'])
  if (!out.ok || out.code !== 0) return undefined
  const commits = parseLog(out.stdout)
  if (!commits) return undefined
  return Object.fromEntries(commits.map((c) => [c.sha, c.subject]))
}

/** The full sha of `rev`, a commit in this checkout; undefined when it is not one. */
export async function resolveCommit(ctx: DeployContext, rev: string): Promise<string | undefined> {
  const out = await git(ctx, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`])
  if (!out.ok || out.code !== 0) return undefined
  const sha = out.stdout.trim()
  return FULL_SHA.test(sha) ? sha : undefined
}

/**
 * What `run` would deploy, for `plan`: HEAD to the branch's tip on the
 * remote. The tip is fetched into {@link PREVIEW_REF} — never into the
 * tracking ref `run` merges from (`--refmap=` also stops git's
 * opportunistic update of it) — and that ref is deleted again.
 */
export async function incomingCommits(ctx: DeployContext, target: { remote: string; head: string }, skipFetch: boolean): Promise<Commits> {
  if (skipFetch) return { ok: false, reason: 'skipped' }
  const head = await resolveCommit(ctx, 'HEAD')
  if (!head) return { ok: false, reason: 'git-failed' }
  const fetched = await git(ctx, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--refmap=', '--', target.remote, `+${target.head}:${PREVIEW_REF}`], FETCH_TIMEOUT_MS)
  try {
    if (!fetched.ok) return { ok: false, reason: fetched.reason === 'timeout' ? 'timeout' : 'not-fetched' }
    if (fetched.code !== 0) return { ok: false, reason: 'not-fetched' }
    const tip = await resolveCommit(ctx, PREVIEW_REF)
    if (!tip) return { ok: false, reason: 'not-fetched' }
    return await commitRange(ctx, head, tip)
  } finally {
    await git(ctx, ['update-ref', '-d', PREVIEW_REF])
  }
}
