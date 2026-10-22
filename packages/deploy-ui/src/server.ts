import { readdir, readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANSWER_ID, MAX_ANSWER_LINES, parseAnswerLine, RUN_ID, type PlanResult } from '@basaltkit/deploy/protocol'
import type { CommandReply, StreamMessage, TargetsReply } from './client/messages.js'
import { APP_CSS, INDEX_HTML } from './page.js'
import { execRemote, follow, toReply, type FollowOptions, type SshRunner } from './remote.js'
import { CLIENT_FILE, checkRequest, MAX_BODY_BYTES, SECURITY_HEADERS } from './security.js'
import { IdleTimer, Session, type TimerApi } from './session.js'
import { MUTATING, SHA, type RemoteCommand, type RemoteSpec } from './ssh.js'
import { ACTOR, checkTarget, isLocale, LOCALES, NAME, readTargets, TargetsFileError, writeTargets, type Target, type TargetsFile } from './targets.js'

/**
 * The UI's local server (RFC 0009 §4, §7): `node:http` on 127.0.0.1 and a
 * port the OS picks, one browser session, ~10 POST routes. A request never
 * carries a host, a path or a flag: it names a target, and the server builds
 * everything else from the operator's targets file.
 */

export interface UiServerOptions {
  targetsPath: string
  runner: SshRunner
  /** The OS user name, the actor when the targets file names none (if it matches the server's pattern). */
  osUser?: string
  /** Default 15, at most 240. */
  idleMinutes?: number
  /** `--pair`: the browser opens the bare URL; the person types {@link UiServer.pairCode} (RFC 0009 Q1). */
  pair?: boolean
  /** Where the compiled client modules are (default: `dist/client` next to this file); null: none. */
  clientDir?: string | null
  /** One line to the terminal. Never a request body, never an answer. */
  log: (line: string) => void
  /** Called once when the server stops on its own (idle, quit). */
  onStop?: (reason: 'idle' | 'quit') => void
  now?: () => number
  random?: (size: number) => Buffer
  timers?: TimerApi
  /** Reconnect pacing for attach (tests). */
  follow?: Pick<FollowOptions, 'sleep' | 'now' | 'windowMs'>
  timeouts?: Partial<Record<'status' | 'plan' | 'detach' | 'cancel', number>>
}

export interface UiServer {
  port: number
  /** `http://127.0.0.1:<port>/` */
  url: string
  /** The URL with the one-time launch code in its fragment — the bare URL with `pair`. */
  launchUrl: string
  /** With `pair`: the code the person types in the page (the terminal shows it). */
  pairCode?: string
  close(): Promise<void>
}

export const MAX_SSH_SESSIONS = 4
export const MAX_IDLE_MINUTES = 240
const DEFAULT_TIMEOUTS = { status: 60_000, plan: 300_000, detach: 120_000, cancel: 60_000 }

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly body?: Record<string, unknown>) {
    super(message)
  }
}

type Body = Record<string, unknown>

async function loadClientFiles(dir: string | null): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  if (dir === null) return files
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return files
  }
  // Read once, at start: no path from a request ever reaches the filesystem.
  for (const name of names) if (CLIENT_FILE.test(name)) files.set(name, await readFile(join(dir, name)))
  return files
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const idleMinutes = Math.min(Math.max(options.idleMinutes ?? 15, 1), MAX_IDLE_MINUTES)
  const session = new Session(options.now, options.random, options.pair === true)
  const clientFiles = await loadClientFiles(options.clientDir === undefined ? fileURLToPath(new URL('./client/', import.meta.url)) : options.clientDir)
  const timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts }
  const osActor = options.osUser && ACTOR.test(options.osUser) ? options.osUser : undefined
  /** The questions of each target's last plan: answers to anything else are refused. */
  const questions = new Map<string, Set<string>>()
  const busy = new Set<string>()
  const controllers = new Set<AbortController>()
  let sshSessions = 0
  let stopped = false

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) refuse(res, 500, 'internal error')
      else res.end()
      options.log(`internal error: ${(error as Error).message}`)
    })
  })
  // No slow-loris on a loopback tool either.
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}/`
  const idle = new IdleTimer(idleMinutes * 60_000, () => { void stop('idle') }, options.timers)

  async function stop(reason: 'idle' | 'quit'): Promise<void> {
    if (stopped) return
    await close()
    options.onStop?.(reason)
  }

  async function close(): Promise<void> {
    if (stopped) return
    stopped = true
    idle.stop()
    for (const controller of controllers) controller.abort()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  function headers(res: ServerResponse, type: string): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
    res.setHeader('Content-Type', type)
  }

  function refuse(res: ServerResponse, status: number, reason: string): void {
    headers(res, 'text/plain; charset=utf-8')
    res.statusCode = status
    res.end(`${reason}\n`)
  }

  function json(res: ServerResponse, status: number, value: unknown): void {
    headers(res, 'application/json; charset=utf-8')
    res.statusCode = status
    res.end(JSON.stringify(value))
  }

  async function readBody(req: IncomingMessage): Promise<Body> {
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of req as AsyncIterable<Buffer>) {
        size += chunk.length
        chunks.push(chunk)
        if (size > MAX_BODY_BYTES) throw new HttpError(413, `the body is larger than ${MAX_BODY_BYTES} bytes`)
      }
      const buffer = Buffer.concat(chunks)
      let value: unknown
      try {
        value = buffer.length === 0 ? {} : JSON.parse(buffer.toString('utf8'))
      } catch {
        throw new HttpError(400, 'the body is not JSON')
      } finally {
        buffer.fill(0)
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'the body is not a JSON object')
      return value as Body
    } finally {
      // The answers travel in request bodies: the buffers this process owns are wiped.
      for (const chunk of chunks) chunk.fill(0)
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const verdict = checkRequest({ method: req.method ?? '', url: req.url ?? '', headers: req.headers }, port)
    if (verdict.kind === 'refuse') return refuse(res, verdict.status, verdict.reason)
    if (verdict.kind === 'static') {
      let content: string | Buffer | undefined
      let type: string
      if (verdict.file === 'index') { content = INDEX_HTML; type = 'text/html; charset=utf-8' }
      else if (verdict.file === 'css') { content = APP_CSS; type = 'text/css; charset=utf-8' }
      else { content = clientFiles.get(verdict.file.client); type = 'text/javascript; charset=utf-8' }
      if (content === undefined) return refuse(res, 404, 'not found')
      headers(res, type)
      res.statusCode = 200
      res.end(req.method === 'HEAD' ? undefined : content)
      return
    }
    if (verdict.route !== 'session' && !session.authorizes(req.headers.authorization)) return refuse(res, 401, 'no session')
    let body: Body
    try {
      body = await readBody(req)
    } catch (error) {
      if (error instanceof HttpError) {
        refuse(res, error.status, error.message)
        req.destroy()
        return
      }
      throw error
    }
    if (verdict.route !== 'session') idle.touch()
    try {
      await route(verdict.route, body, res)
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      if (error.body) json(res, error.status, { error: error.message, ...error.body })
      else json(res, error.status, { error: error.message })
    }
  }

  // ── targets ──────────────────────────────────────────────────────────────

  async function loadFile(): Promise<{ file: TargetsFile; exists: boolean }> {
    try {
      return await readTargets(options.targetsPath)
    } catch (error) {
      if (error instanceof TargetsFileError) throw new HttpError(409, error.message)
      throw error
    }
  }

  async function target(body: Body): Promise<{ target: Target; actor: string | undefined }> {
    const name = body['target']
    if (typeof name !== 'string' || !NAME.test(name)) throw new HttpError(400, 'target: a target name')
    const { file } = await loadFile()
    const found = file.targets.find((t) => t.name === name)
    if (!found) throw new HttpError(404, `no target "${name}"`)
    return { target: found, actor: file.actor ?? osActor }
  }

  async function targetsReply(): Promise<TargetsReply> {
    try {
      const { file, exists } = await readTargets(options.targetsPath)
      const actor = file.actor ?? osActor
      return { path: options.targetsPath, exists, ...(actor ? { actor } : {}), ...(file.locale ? { locale: file.locale } : {}), targets: file.targets }
    } catch (error) {
      if (error instanceof TargetsFileError) return { path: options.targetsPath, exists: true, targets: [], error: error.message }
      throw error
    }
  }

  // ── remote commands ──────────────────────────────────────────────────────

  function claim(name: string, command: RemoteCommand): () => void {
    if (sshSessions >= MAX_SSH_SESSIONS) throw new HttpError(429, `at most ${MAX_SSH_SESSIONS} ssh sessions at a time`)
    const mutating = MUTATING.has(command)
    if (mutating && busy.has(name)) throw new HttpError(409, `a change to ${name} is already in progress from this UI`)
    sshSessions++
    if (mutating) busy.add(name)
    let released = false
    return () => {
      if (released) return
      released = true
      sshSessions--
      if (mutating) busy.delete(name)
    }
  }

  async function collect(t: Target, actor: string | undefined, spec: RemoteSpec, timeoutMs: number, stdin?: Buffer): Promise<CommandReply> {
    const release = claim(t.name, spec.command)
    const controller = new AbortController()
    controllers.add(controller)
    // A slow plan or a run --detach still detaching is not idleness: stopping
    // now would SIGTERM it and lose its runId.
    idle.hold()
    try {
      options.log(`${t.name}: ${spec.command}`)
      const outcome = await execRemote(options.runner, t, spec, {
        timeoutMs, signal: controller.signal,
        ...(actor ? { actor } : {}),
        ...(stdin ? { stdin } : {}),
      })
      return toReply(outcome)
    } finally {
      controllers.delete(controller)
      idle.release()
      release()
    }
  }

  function openStream(res: ServerResponse): { send: (message: StreamMessage) => void; controller: AbortController; end: () => void } {
    headers(res, 'application/x-ndjson; charset=utf-8')
    res.statusCode = 200
    res.flushHeaders()
    const controller = new AbortController()
    controllers.add(controller)
    idle.hold()
    let open = true
    // The page went away: an attended command stops (its ssh session ends), a follow stops watching.
    res.on('close', () => { if (open) controller.abort() })
    // A write to a page that is gone is dropped, never a crash.
    res.on('error', () => controller.abort())
    return {
      controller,
      send: (message) => { if (open && !res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(message)}\n`) },
      end: () => {
        if (!open) return
        open = false
        controllers.delete(controller)
        idle.release()
        res.end()
      },
    }
  }

  async function streamRemote(res: ServerResponse, t: Target, actor: string | undefined, spec: RemoteSpec, stdin: Buffer | undefined): Promise<void> {
    const release = claim(t.name, spec.command)
    const stream = openStream(res)
    try {
      options.log(`${t.name}: ${spec.command} (attended)`)
      stream.send({ kind: 'state', state: 'connecting' })
      const outcome = await execRemote(options.runner, t, spec, {
        signal: stream.controller.signal,
        ...(actor ? { actor } : {}),
        ...(stdin ? { stdin } : {}),
        onEvent: (event, known) => stream.send(event.type === 'hello' ? { kind: 'hello', hello: event } : { kind: 'event', event, known }),
        onDiagnostic: (text) => stream.send({ kind: 'diagnostic', text }),
      })
      for (const text of outcome.stderr) stream.send({ kind: 'diagnostic', text })
      const failure = outcome.failure
      stream.send(failure
        ? { kind: 'state', state: 'ended', code: failure.code, reason: failure.message, ...(failure.hint ? { hint: failure.hint } : {}) }
        : { kind: 'state', state: 'ended', ...(outcome.done ? { exitCode: outcome.done.exitCode } : {}) })
    } finally {
      release()
      stream.end()
    }
  }

  /** The answers, checked and serialised as the protocol's answer lines; only ids the target's last plan asked. */
  function answerLines(name: string, input: unknown): Buffer | undefined {
    if (input === undefined) return undefined
    if (!Array.isArray(input) || input.length > MAX_ANSWER_LINES) throw new HttpError(400, `answers: a list of at most ${MAX_ANSWER_LINES}`)
    if (input.length === 0) return undefined
    const asked = questions.get(name)
    if (!asked) throw new HttpError(409, `run plan for ${name} first: answers are checked against its questions`)
    const seen = new Set<string>()
    const lines: string[] = []
    for (const item of input) {
      const id = (item as { id?: unknown } | null)?.id
      const value = (item as { value?: unknown } | null)?.value
      if (typeof id !== 'string' || !ANSWER_ID.test(id)) throw new HttpError(400, 'answers: each id is env.<KEY>')
      if (!asked.has(id)) throw new HttpError(400, `answers: ${id} is not one of the questions of the last plan`, { field: id })
      if (seen.has(id)) throw new HttpError(400, `answers: ${id} twice`, { field: id })
      seen.add(id)
      if (typeof value !== 'string') throw new HttpError(400, `answers: the value of ${id} is not a string`, { field: id })
      const line = JSON.stringify({ v: 1, type: 'answer', id, value })
      // Never quotes the value: the parser's errors name the id only.
      const parsed = parseAnswerLine(line)
      if (!parsed.ok) throw new HttpError(400, parsed.error, { field: id })
      lines.push(line)
    }
    return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
  }

  /**
   * The operator confirmed a destination their page showed; the file is read
   * again for each request. Both must be the same target, field for field, or
   * nothing is sent: a file changed in between never redirects the answers.
   */
  function confirmed(body: Body, t: Target, what: string): void {
    if (body['confirm'] !== true) throw new HttpError(428, `${what} needs a confirmation`)
    if (t.protected && body['confirmName'] !== t.name) throw new HttpError(428, `${t.name} is protected: type its name to confirm ${what}`)
    const shown = checkTarget(body['confirmedTarget'])
    if (!shown.ok) throw new HttpError(400, 'confirmedTarget: the target as the confirmation showed it')
    if (JSON.stringify(shown.value) !== JSON.stringify(t)) {
      throw new HttpError(409, `${t.name} changed in the targets file after you confirmed (${shown.value.ssh} · ${shown.value.dir} → ${t.ssh} · ${t.dir}): nothing was sent — check it and confirm again`, { changed: true })
    }
  }

  function runIdOf(body: Body): string {
    const runId = body['runId']
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new HttpError(400, 'runId: a run id')
    return runId
  }

  async function route(name: string, body: Body, res: ServerResponse): Promise<void> {
    switch (name) {
      case 'session': {
        const exchange = session.exchange(body['code'])
        if (exchange.ok) {
          idle.touch()
          options.log('the browser session is open')
          return json(res, 200, { token: exchange.token, serverKey: exchange.serverKey })
        }
        if (exchange.status === 409) options.log('a second browser tried to claim the session: refused (if that was not you, quit and restart)')
        else options.log(`a session request was refused: ${exchange.reason}`)
        return refuse(res, exchange.status, exchange.reason)
      }
      case 'hello': {
        // The page's check that it still talks to this process (see Session).
        const proof = session.prove(body['nonce'])
        if (!proof) throw new HttpError(400, 'nonce: 22 to 128 base64url characters')
        return json(res, 200, { proof })
      }
      case 'targets':
        return json(res, 200, await targetsReply())
      case 'targets/save': {
        const { file } = await loadFile()
        let targets = file.targets
        if (body['target'] !== undefined) {
          const checked = checkTarget(body['target'])
          if (!checked.ok) throw new HttpError(422, 'the target is refused', { errors: checked.errors })
          const previous = typeof body['previousName'] === 'string' ? body['previousName'] : checked.value.name
          if (checked.value.name !== previous && targets.some((t) => t.name === checked.value.name)) {
            throw new HttpError(422, 'the target is refused', { errors: { name: `"${checked.value.name}" is already a target` } })
          }
          const index = targets.findIndex((t) => t.name === previous)
          targets = index === -1 ? [...targets, checked.value] : targets.map((t, i) => (i === index ? checked.value : t))
        }
        let actor = file.actor
        if (body['actor'] !== undefined) {
          const given = body['actor']
          if (given === null || given === '') actor = undefined
          else if (typeof given !== 'string' || !ACTOR.test(given)) throw new HttpError(422, 'the actor is refused', { errors: { actor: 'letters, digits and ._@+-, at most 64' } })
          else actor = given
        }
        let locale = file.locale
        if (body['locale'] !== undefined) {
          if (body['locale'] !== null && !isLocale(body['locale'])) throw new HttpError(422, 'the language is refused', { errors: { locale: `one of ${LOCALES.join(', ')}` } })
          locale = body['locale'] ?? undefined
        }
        await writeTargets(options.targetsPath, { version: 1, ...(actor ? { actor } : {}), ...(locale ? { locale } : {}), targets })
        options.log(`targets saved to ${options.targetsPath}`)
        return json(res, 200, await targetsReply())
      }
      case 'targets/remove': {
        const removed = body['name']
        if (typeof removed !== 'string' || !NAME.test(removed)) throw new HttpError(400, 'name: a target name')
        const { file } = await loadFile()
        await writeTargets(options.targetsPath, { ...file, targets: file.targets.filter((t) => t.name !== removed) })
        questions.delete(removed)
        return json(res, 200, await targetsReply())
      }
      case 'status': {
        const { target: t, actor } = await target(body)
        return json(res, 200, await collect(t, actor, { command: 'status' }, timeouts.status))
      }
      case 'commits': {
        // Read-only on the server (no lock): the history's changes and the rollback preview.
        const { target: t, actor } = await target(body)
        const sha = (name: 'from' | 'to') => {
          const value = body[name]
          if (value !== undefined && (typeof value !== 'string' || !SHA.test(value))) throw new HttpError(400, `${name}: a commit sha (7 to 40 lowercase hex)`)
          return value as string | undefined
        }
        const from = sha('from')
        const to = sha('to')
        if (body['rollback'] !== undefined && body['rollback'] !== true) throw new HttpError(400, 'rollback: true or absent')
        const preview = body['rollback'] === true
        if (preview ? from !== undefined : from === undefined || to === undefined) throw new HttpError(400, 'commits: from and to, or rollback (with an optional to)')
        const spec: RemoteSpec = { command: 'commits', ...(preview ? { rollbackPreview: true } : {}), ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }
        return json(res, 200, await collect(t, actor, spec, timeouts.status))
      }
      case 'plan': {
        const { target: t, actor } = await target(body)
        const reply = await collect(t, actor, { command: 'plan' }, timeouts.plan)
        const result = reply.result as Partial<PlanResult> | undefined
        if (reply.hello && Array.isArray(result?.questions)) questions.set(t.name, new Set(result.questions.map((q) => q.id)))
        return json(res, 200, reply)
      }
      case 'env': {
        const { target: t, actor } = await target(body)
        confirmed(body, t, 'writing the .env')
        const stdin = answerLines(t.name, body['answers'])
        return streamRemote(res, t, actor, { command: 'env', ...(stdin ? { answers: true } : {}) }, stdin)
      }
      case 'run': {
        const { target: t, actor } = await target(body)
        confirmed(body, t, 'a deploy')
        const stdin = answerLines(t.name, body['answers'])
        const spec: RemoteSpec = { command: 'run', ...(stdin ? { answers: true } : {}), ...(body['unhold'] === true ? { unhold: true } : {}) }
        if (body['attended'] === true) return streamRemote(res, t, actor, spec, stdin)
        return json(res, 200, await collect(t, actor, { ...spec, detach: true }, timeouts.detach, stdin))
      }
      case 'rollback': {
        const { target: t, actor } = await target(body)
        confirmed(body, t, 'a rollback')
        const to = body['to']
        if (to !== undefined && (typeof to !== 'string' || !SHA.test(to))) throw new HttpError(400, 'to: a commit sha (7 to 40 lowercase hex)')
        return json(res, 200, await collect(t, actor, { command: 'rollback', detach: true, ...(to === undefined ? {} : { to }) }, timeouts.detach))
      }
      case 'attach': {
        const { target: t } = await target(body)
        const runId = runIdOf(body)
        const fromSeq = body['fromSeq'] ?? 0
        if (typeof fromSeq !== 'number' || !Number.isSafeInteger(fromSeq) || fromSeq < 0) throw new HttpError(400, 'fromSeq: a whole number')
        const release = claim(t.name, 'attach')
        const stream = openStream(res)
        try {
          options.log(`${t.name}: attach ${runId} from ${fromSeq}`)
          await follow(options.runner, t, runId, fromSeq, stream.send, { signal: stream.controller.signal, ...options.follow })
        } finally {
          release()
          stream.end()
        }
        return
      }
      case 'cancel': {
        const { target: t, actor } = await target(body)
        const runId = runIdOf(body)
        if (body['confirm'] !== true) throw new HttpError(428, 'cancel needs a confirmation')
        // First or second is the server's state (`<runId>.cancel`), not this
        // process's: a cancel from a terminal or an earlier UI session counts.
        // Without the explicit `second`, the server refuses rather than sending
        // the immediate second signal.
        const second = body['second'] === true
        const reply = await collect(t, actor, { command: 'cancel', runId, ...(second ? {} : { firstOnly: true }) }, timeouts.cancel)
        if (!second && reply.error?.code === 'already-cancelled') {
          throw new HttpError(428, 'this run was already cancelled once (from a terminal, another session or this page): a second cancel ends it at once, mid-step — confirm that explicitly', { second: true })
        }
        return json(res, 200, reply)
      }
      case 'quit':
        json(res, 200, { ok: true })
        options.log('quit from the page')
        setImmediate(() => { void stop('quit') })
        return
      default:
        throw new HttpError(404, 'no such route')
    }
  }

  return session.pair ? { port, url, launchUrl: url, pairCode: session.launchCode, close } : { port, url, launchUrl: `${url}#launch=${session.launchCode}`, close }
}
