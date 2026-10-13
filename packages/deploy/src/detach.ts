import type { AnswerChannel } from './answers.js'
import { DeployError, type DeployContext } from './context.js'
import { formatValue, UnwritableValueError } from './dotenv.js'
import { planEnv, readEnv } from './env-step.js'
import { envValues } from './dotenv.js'
import type { Reporter } from './events.js'
import { DeployLockedError, describeHolder, readLock } from './lock.js'
import type { DeployEvent } from './protocol.js'
import { createRunLog, newRunId, scanRunLog } from './runs.js'

/** The marker a detached child is started with; `--run-id` is refused without it. */
export const DETACHED_CHILD_ENV = 'BASALT_DEPLOY_DETACHED_CHILD'
/** How long the parent waits for the child to hold the lock. */
export const DETACH_CONFIRM_MS = 30_000
const POLL_MS = 250

export interface DetachRequest {
  command: 'run' | 'rollback'
  /** The flags the child gets again (never an answer). */
  forward: string[]
  answers?: AnswerChannel
  /** `node` and this package's bin.js. */
  execPath: string
  binPath: string
}

/**
 * `run --detach` / `rollback --detach` (RFC 0008 §8.2), the parent: it never
 * takes the lock. Everything the child would need to ask is checked here
 * first; the child is started in its own session with the answers on its
 * stdin only; the parent returns once the child holds the lock.
 */
export async function detach(ctx: DeployContext, request: DetachRequest, reporter: Reporter): Promise<number> {
  const { host } = ctx
  if (!host.spawnDetached || !host.createLog) throw new DeployError('this host cannot start a detached run', [], 'unsupported')
  if (request.answers) await request.answers.drain()
  if (request.command === 'run') await checkAnswers(ctx, request.answers)

  // Advisory: the child's acquireLock decides; this only saves a pointless start.
  const lock = await readLock(host, ctx.stateDir)
  if (lock?.corrupt) throw new DeployLockedError(`${lock.path} exists but is not a deploy lock (empty, unreadable or not a plain file) — if no deploy is running: rm ${lock.path}`)
  if (lock?.holder && !lock.stale) throw new DeployLockedError(`another deploy is running: ${describeHolder(lock.holder)} — wait for it`, lock.holder)

  const runId = newRunId(host)
  const { path, handle } = await createRunLog(host, ctx.stateDir, runId)
  let pid: number
  try {
    ;({ pid } = await host.spawnDetached(request.execPath, [request.binPath, request.command, '--json=1', `--run-id=${runId}`, ...request.forward], {
      cwd: ctx.dir,
      env: { ...host.env, [DETACHED_CHILD_ENV]: '1' },
      stdin: request.answers?.serialize() ?? '',
      stdout: handle,
    }))
  } finally {
    handle.close()
  }

  const deadline = host.now().getTime() + DETACH_CONFIRM_MS
  for (;;) {
    const events = await scanRunLog(host, path)
    const locked = events.find((e): e is Extract<DeployEvent, { type: 'step-end' }> => e.type === 'step-end' && e.id === 'lock')
    if (locked?.status === 'ok') {
      reporter.emit({ type: 'result', command: request.command, data: { runId, pid, log: path } })
      return 0
    }
    const done = events.find((e): e is Extract<DeployEvent, { type: 'done' }> => e.type === 'done')
    if (done) {
      const error = [...events].reverse().find((e): e is Extract<DeployEvent, { type: 'error' }> => e.type === 'error')
      if (error) {
        const { v: _v, ts: _ts, seq: _seq, runId: _run, redacted: _r, ...body } = error
        reporter.emit(body)
      }
      return done.exitCode
    }
    if (host.now().getTime() >= deadline) {
      throw new DeployError(`run ${runId} started (pid ${pid}) but did not confirm holding the lock within ${DETACH_CONFIRM_MS / 1000} s — it is not stopped`, [], 'detach-unconfirmed', `attach ${runId}`)
    }
    await host.sleep(POLL_MS)
  }
}

/**
 * Every question `run` would ask now is answered — by the deploy's own
 * environment or by an answer line — and the answer can be written: a
 * detached run cannot ask. Read-only: the `.env` as it is, no lock.
 */
async function checkAnswers(ctx: DeployContext, answers: AnswerChannel | undefined): Promise<void> {
  const document = await readEnv(ctx)
  const values = envValues(document)
  const plan = planEnv(ctx, document, Number(values.get('PORT')) || 0, [])
  const missing: string[] = []
  for (const key of plan.questions) {
    const question = ctx.config.env.ask?.[key]
    if (!question || ctx.host.env[key] !== undefined) continue
    const given = answers?.peek(`env.${key}`)?.trim()
    if (given === undefined) {
      if (!question.optional) missing.push(key)
      continue
    }
    const value = given === '' && question.default !== undefined ? question.default : given
    if (value === '' && !question.optional) throw new DeployError(`${key} is required: the answer is empty — nothing was started`, [], 'answer-invalid')
    try {
      formatValue(value, key)
    } catch (error) {
      if (!(error instanceof UnwritableValueError)) throw error
      throw new DeployError(`${error.message} — nothing was started`, [], 'answer-invalid')
    }
  }
  if (missing.length > 0) {
    throw new DeployError(`a detached run cannot ask: no answer for ${missing.join(', ')} — nothing was started`, [], 'answer-missing', 'send them with --answers=stdin (plan --json lists them), or in the environment of the command')
  }
}
