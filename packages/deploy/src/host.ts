import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants, openSync, closeSync, writeSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import tls from 'node:tls'
import type { Finding } from './context.js'
import type { ResultCommand, ResultPayloads, StepId, StepStatus } from './protocol.js'

/**
 * Every side effect the pipeline has goes through this interface: processes,
 * files, the terminal, the network, the clock. The real one is {@link nodeHost};
 * the tests drive the whole pipeline with a fake one, including each production
 * incident the checks were written for (RFC 0006 §A).
 */
export interface Host {
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>
  readFile(path: string): Promise<string | undefined>
  /** Atomic (temp file + rename) and created with `mode` before any byte is written. */
  writeFile(path: string, content: string, mode?: number): Promise<void>
  copyFile(from: string, to: string, mode?: number): Promise<void>
  exists(path: string): Promise<boolean>
  /** lstat: a symlink is reported as one, never followed. */
  stat(path: string): Promise<FileStat | undefined>
  chmod(path: string, mode: number): Promise<void>
  /** The path with every symlink resolved, or `undefined` when it does not exist. */
  realpath(path: string): Promise<string | undefined>
  /**
   * Reads a regular file without following a symlink at `path` (O_NOFOLLOW),
   * up to `maxBytes`. Throws for a link, a non-regular file or a larger one —
   * how root reads a file the app user wrote.
   */
  readPlainFile(path: string, maxBytes: number): Promise<string>
  /**
   * Gives `path` to `uid:gid` with `mode`, through a descriptor opened with
   * O_NOFOLLOW: a symlink planted at `path` is refused, never followed; a file
   * with more than one hard link too. How root changes a file in a directory
   * the app user can write.
   */
  secureOwner(path: string, owner: { uid: number; gid: number; mode: number; kind: 'file' | 'dir' }): Promise<void>
  readlink(path: string): Promise<string | undefined>
  symlink(target: string, path: string): Promise<void>
  mkdir(path: string, mode?: number): Promise<void>
  /** Recursive and forced (`rm -rf`): never as root under a directory another user can write. */
  remove(path: string): Promise<void>
  /**
   * unlink(2) of one entry: a file, or a symlink itself (never its target);
   * a directory is an error, never descended into. Nothing there is fine.
   */
  removeFile(path: string): Promise<void>
  list(dir: string): Promise<string[]>
  /**
   * A line typed by a person, or `undefined` when nobody can answer (no TTY).
   * `meta` names the question for a program answering it (RFC 0008 §7.2);
   * the terminal ignores it.
   */
  prompt(question: string, options: { secret: boolean }, meta?: PromptMeta): Promise<string | undefined>
  confirm(question: string): Promise<boolean>
  randomHex(bytes: number): string
  now(): Date
  sleep(ms: number): Promise<void>
  /** The certificate a TLS server presents for `servername`: its names, or why the chain is not trusted. */
  tlsCertificate(servername: string): Promise<TlsCertificate | { error: string }>
  /** GET with an explicit `Host` header (fetch forbids setting it). Never throws. */
  httpGet(url: string, options?: { host?: string; timeoutMs?: number }): Promise<{ status: number } | { error: string }>
  /** The environment the deploy itself was started with (answers for non-interactive runs). */
  env: Readonly<Record<string, string | undefined>>
  /** Whether a person can answer a prompt (a terminal, not CI). */
  interactive(): boolean
  uid(): number
  /** This process's id (recorded in the deploy lock). */
  pid(): number
  hostname(): string
  /** Whether a process with this id runs on this host (a stale lock's holder does not). */
  processAlive(pid: number): boolean
  /**
   * Creates `path` with `content` only when nothing is there — O_EXCL, so a
   * symlink planted at `path` is not followed. `false` when it already exists.
   */
  createExclusive(path: string, content: string, mode: number): Promise<boolean>
  /**
   * SIGINT, SIGTERM and SIGHUP while a deploy runs: the listener hears the
   * first; a second one ends the process at once. Returns the unsubscribe.
   */
  onSignal(listener: (signal: string) => void): () => void
  out: Output

  // ── optional: the machine protocol (RFC 0008). A host without them refuses --detach and cancel. ──

  /**
   * Creates `path` for appending — O_CREAT|O_EXCL|O_NOFOLLOW, `mode` — and
   * returns a handle: a run log. Something already there (a planted symlink
   * included) is an error, never followed or reused.
   */
  createLog?(path: string, mode: number): Promise<LogHandle>
  /**
   * Up to `length` bytes of `path` from `offset`, read through a descriptor
   * opened with O_NOFOLLOW, with what fstat says of that file. Throws for a
   * symlink or a non-regular file.
   */
  readFileRange?(path: string, offset: number, length: number): Promise<FileRange>
  /**
   * Starts `command` in its own session (setsid: no controlling terminal, no
   * SIGHUP when the SSH session ends), stdin a pipe that receives `stdin` and
   * is closed, stdout the log handle, stderr /dev/null; not waited for.
   */
  spawnDetached?(command: string, args: string[], options: { cwd: string; env: Record<string, string | undefined>; stdin: string; stdout: LogHandle }): Promise<{ pid: number }>
  /** kill(2) of one process (never its group). */
  kill?(pid: number, signal: 'SIGTERM'): void
  /** The process's argv (Linux /proc/<pid>/cmdline), or `undefined` when it cannot be known. */
  processCmdline?(pid: number): Promise<string[] | undefined>
}

/** Who a prompt is for, for a program that answers it (RFC 0008 §7.2). */
export interface PromptMeta {
  /** `env.<KEY>`. */
  id: string
  key: string
  optional: boolean
  default?: string
}

export interface LogHandle {
  append(text: string): void
  close(): void
  /** The descriptor, for a detached child's stdout. */
  readonly fd?: number
}

export interface FileRange {
  data: Uint8Array
  /** The whole file's size. */
  size: number
  uid: number
  /** Permission bits. */
  mode: number
}

export interface FileStat {
  kind: 'file' | 'dir' | 'symlink' | 'other'
  size: number
  /** Permission bits (`& 0o7777`). */
  mode?: number
  uid?: number
  gid?: number
}

export interface ExecOptions {
  cwd?: string
  /** Added to the inherited environment (or the whole environment with `inheritEnv: false`). */
  env?: Record<string, string>
  /** Removed from the inherited environment (e.g. `NODE_ENV` for an install with devDependencies). */
  unset?: string[]
  /** `false` → the child sees `env` and `PATH`/`HOME` only. */
  inheritEnv?: boolean
  /** stdout goes to this file (created 0600), not to memory. */
  stdoutFile?: string
  /** stdout/stderr go to the terminal (long steps), nothing is captured. */
  stream?: boolean
  /** Written to the child's stdin, then closed — SQL that carries a password, never an argument. */
  stdin?: string
  /** The child gets this terminal (stdin too): it may ask questions. Nothing is captured. */
  interactive?: boolean
  /**
   * With `stream`: stdout/stderr are piped (stdin stays closed) and handed
   * here as decoded text, instead of going to the terminal (RFC 0008 §5.3).
   */
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface TlsCertificate {
  /** `subjectAltName` DNS names, lowercased (`*.example.com` included as written). */
  names: string[]
  validTo: Date
  /** Whether the chain verifies against the system's roots; the reason when it does not. */
  trusted: boolean
  trustError?: string
}

export interface Output {
  /** A step begins; `id` names it for a program (the terminal shows the title). */
  step(title: string, id?: StepId): void
  info(message: string): void
  ok(message: string): void
  warn(message: string): void
  error(message: string): void
  // Optional: implemented by the machine protocol's output (RFC 0008 §5.1); the terminal has none.
  /** The step `id` ended. */
  stepEnd?(id: StepId, status: StepStatus, durationMs: number): void
  /** A finding, structured (the terminal gets it as text). */
  finding?(finding: Finding): void
  /** The command's payload. */
  result?<C extends ResultCommand>(command: C, data: ResultPayloads[C]): void
}

export function consoleOutput(stream: NodeJS.WriteStream = process.stderr): Output {
  const color = stream.isTTY && !process.env['NO_COLOR']
  const paint = (code: string, text: string) => (color ? `\u001b[${code}m${text}\u001b[0m` : text)
  return {
    step: (title) => stream.write(`\n${paint('1', `==> ${title}`)}\n`),
    info: (message) => stream.write(`    ${message}\n`),
    ok: (message) => stream.write(`    ${paint('32', 'ok')} ${message}\n`),
    warn: (message) => stream.write(`    ${paint('33', 'warning')} ${message}\n`),
    error: (message) => stream.write(`    ${paint('31', 'error')} ${message}\n`),
  }
}

export function nodeHost(output: Output = consoleOutput()): Host {
  return {
    out: output,
    env: process.env,
    uid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
    pid: () => process.pid,
    hostname: () => hostname(),
    processAlive(pid) {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        // EPERM: it exists, under another user.
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    async createExclusive(path, content, mode) {
      try {
        await writeFile(path, content, { mode, flag: 'wx' })
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw error
      }
    },
    onSignal(listener) {
      const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
      let heard = 0
      const handler = (signal: NodeJS.Signals) => {
        heard++
        if (heard === 1) { listener(signal); return }
        output.error(`${signal} again: stopping now, mid-step — the lock is cleared by the next deploy (its process is gone)`)
        process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143)
      }
      for (const signal of SIGNALS) process.on(signal, handler)
      return () => { for (const signal of SIGNALS) process.off(signal, handler) }
    },
    interactive: () => Boolean(process.stdin.isTTY) && !process.env['CI'],
    now: () => new Date(),
    randomHex: (bytes) => randomBytes(bytes).toString('hex'),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),

    exec(command, args, options = {}) {
      const base: Record<string, string | undefined> = options.inheritEnv === false
        ? { PATH: process.env['PATH'], HOME: process.env['HOME'] }
        : { ...process.env }
      for (const key of options.unset ?? []) delete base[key]
      const env = { ...base, ...options.env }
      let fd: number | undefined
      if (options.stdoutFile) {
        fd = openSync(options.stdoutFile, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600)
      }
      return new Promise((resolve) => {
        let stdout = ''
        let stderr = ''
        const sink = options.stream ? options.onOutput : undefined
        const child = spawn(command, args, {
          cwd: options.cwd,
          env,
          stdio: options.interactive ? 'inherit'
            : sink ? ['ignore', 'pipe', 'pipe']
            : options.stream ? ['ignore', 'inherit', 'inherit']
            : [options.stdin === undefined ? 'ignore' : 'pipe', fd ?? 'pipe', 'pipe'],
        })
        if (options.stdin !== undefined) child.stdin?.end(options.stdin)
        const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
        if (sink) {
          child.stdout?.on('data', (chunk: Buffer) => sink(decoders.stdout.write(chunk), 'stdout'))
          child.stderr?.on('data', (chunk: Buffer) => sink(decoders.stderr.write(chunk), 'stderr'))
        } else {
          child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
          child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
        }
        let finished = false
        const done = (code: number) => {
          if (finished) return
          finished = true
          if (fd !== undefined) closeSync(fd)
          if (sink) { sink(decoders.stdout.end(), 'stdout'); sink(decoders.stderr.end(), 'stderr') }
          resolve({ code, stdout, stderr })
        }
        child.on('error', (error) => { stderr += error.message; done(127) })
        child.on('close', (code) => done(code ?? 1))
      })
    },

    async readFile(path) {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return undefined
      }
    },
    async writeFile(path, content, mode = 0o644) {
      const temp = `${path}.basalt-${randomBytes(4).toString('hex')}`
      await writeFile(temp, content, { mode, flag: 'wx' })
      await chmod(temp, mode)
      await rename(temp, path)
    },
    async copyFile(from, to, mode) {
      await copyFile(from, to)
      if (mode !== undefined) await chmod(to, mode)
    },
    async exists(path) {
      try {
        await lstat(path)
        return true
      } catch {
        return false
      }
    },
    async stat(path) {
      try {
        const s = await lstat(path)
        const kind = s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other'
        return { kind, size: s.size, mode: s.mode & 0o7777, uid: s.uid, gid: s.gid }
      } catch {
        return undefined
      }
    },
    async readlink(path) {
      try {
        return await readlink(path)
      } catch {
        return undefined
      }
    },
    symlink: (target, path) => symlink(target, path),
    chmod: (path, mode) => chmod(path, mode),
    async realpath(path) {
      try {
        return await realpath(path)
      } catch {
        return undefined
      }
    },
    async readPlainFile(path, maxBytes) {
      const handle = await openNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        const s = await handle.stat()
        if (!s.isFile()) throw new Error(`${path} is not a regular file`)
        if (s.size > maxBytes) throw new Error(`${path} is larger than ${maxBytes} bytes`)
        return await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
    },
    async secureOwner(path, { uid, gid, mode, kind }) {
      const handle = await openNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK | (kind === 'dir' ? constants.O_DIRECTORY : 0))
      try {
        const s = await handle.stat()
        if (kind === 'file' && !s.isFile()) throw new Error(`${path} is not a regular file`)
        if (kind === 'dir' && !s.isDirectory()) throw new Error(`${path} is not a directory`)
        // A hard link to another file (a password file, say) would change that file too.
        if (kind === 'file' && s.nlink !== 1) throw new Error(`${path} has ${s.nlink} hard links`)
        await handle.chown(uid, gid)
        await handle.chmod(mode)
      } finally {
        await handle.close()
      }
    },
    async mkdir(path, mode) {
      await mkdir(path, { recursive: true, ...(mode === undefined ? {} : { mode }) })
    },
    remove: (path) => rm(path, { force: true, recursive: true }),
    async removeFile(path) {
      try {
        await unlink(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
    async list(dir) {
      try {
        return await readdir(dir)
      } catch {
        return []
      }
    },

    async prompt(question, { secret }) {
      if (!process.stdin.isTTY || process.env['CI']) return undefined
      // The question and the echo go to stderr: anything a prompt writes to
      // stdout can end up inside a captured value (RFC 0006 §A, incident 5).
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
      if (secret && !muteEcho(rl, (s) => process.stderr.write(s))) {
        // Fail closed: never ask for a secret that would be echoed.
        rl.close()
        output.warn('this Node cannot hide what is typed: give the secret in the environment of the command instead')
        return undefined
      }
      const answer = await new Promise<string>((resolve) => rl.question(`    ${question}: `, resolve))
      rl.close()
      if (secret) process.stderr.write('\n')
      return answer.trim()
    },
    async confirm(question) {
      if (!process.stdin.isTTY || process.env['CI']) return false
      const rl = createInterface({ input: process.stdin, output: process.stderr })
      const answer = await new Promise<string>((resolve) => rl.question(`    ${question} [y/N] `, resolve))
      rl.close()
      return /^y(es)?$/i.test(answer.trim())
    },

    tlsCertificate: (servername) => probeTls(servername, { host: servername, port: 443 }),

    async createLog(path, mode) {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_APPEND, mode)
      return {
        fd,
        append(text) {
          const bytes = Buffer.from(text, 'utf8')
          for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written)
        },
        close() { closeSync(fd) },
      }
    },
    async readFileRange(path, offset, length) {
      const handle = await openNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        const s = await handle.stat()
        if (!s.isFile()) throw new Error(`${path} is not a regular file`)
        const data = Buffer.alloc(Math.max(0, Math.min(length, s.size - offset)))
        let read = 0
        while (read < data.length) {
          const { bytesRead } = await handle.read(data, read, data.length - read, offset + read)
          if (bytesRead === 0) break
          read += bytesRead
        }
        return { data: data.subarray(0, read), size: s.size, uid: s.uid, mode: s.mode & 0o7777 }
      } finally {
        await handle.close()
      }
    },
    spawnDetached(command, args, options) {
      return new Promise((resolve, reject) => {
        if (options.stdout.fd === undefined) { reject(new Error('the run log has no descriptor')); return }
        const child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env,
          // setsid(2): its own session and process group, no controlling terminal.
          detached: true,
          stdio: ['pipe', options.stdout.fd, 'ignore'],
        })
        child.once('error', reject)
        child.once('spawn', () => {
          child.stdin?.end(options.stdin)
          child.unref()
          resolve({ pid: child.pid as number })
        })
      })
    },
    kill(pid, signal) { process.kill(pid, signal) },
    async processCmdline(pid) {
      if (process.platform !== 'linux') return undefined
      try {
        return (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\u0000').filter(Boolean)
      } catch {
        return undefined
      }
    },

    httpGet(url, options = {}) {
      return new Promise((resolve) => {
        const target = new URL(url)
        const client = target.protocol === 'https:' ? https : http
        const request = client.request(target, {
          method: 'GET',
          headers: options.host ? { host: options.host } : {},
          timeout: options.timeoutMs ?? 5_000,
        }, (response) => {
          response.resume()
          resolve({ status: response.statusCode ?? 0 })
        })
        request.on('timeout', () => request.destroy(new Error('timed out')))
        request.on('error', (error) => resolve({ error: error.message }))
        request.end()
      })
    },
  }
}

/**
 * Readline echoes what is typed through its internal `_writeToOutput`; a
 * secret answer replaces it so only the question is written. Returns false
 * when that internal is gone (a Node that changed it): the caller must not
 * ask then — fail closed, never echo a secret.
 */
export function muteEcho(rl: unknown, write: (text: string) => void): boolean {
  const writer = rl as { _writeToOutput?: unknown }
  if (typeof writer._writeToOutput !== 'function') return false
  let asked = false
  writer._writeToOutput = (text: string) => {
    if (!asked) { write(text); asked = true }
  }
  return true
}

/**
 * The certificate `host:port` presents for `servername`. The chain is
 * verified as any client would (the system's roots), but an untrusted or
 * expired one is REPORTED, with its names and expiry, instead of failing the
 * handshake — what C8 says to the operator. Only network failures are
 * errors. Nothing is sent over the connection.
 */
export function probeTls(servername: string, target: { host: string; port: number; timeoutMs?: number }): Promise<TlsCertificate | { error: string }> {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: target.host, port: target.port, servername, timeout: target.timeoutMs ?? 10_000,
      // Reported, not refused: `authorized` says whether the chain verifies.
      rejectUnauthorized: false,
      // The name check is ours (covers()): a name mismatch is not a trust error.
      checkServerIdentity: () => undefined,
    })
    const finish = (value: TlsCertificate | { error: string }) => { socket.destroy(); resolve(value) }
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      const names = (cert.subjectaltname ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith('DNS:'))
        .map((entry) => entry.slice(4).toLowerCase())
      const trustError = socket.authorized ? undefined : String(socket.authorizationError ?? 'unknown')
      finish({ names, validTo: new Date(cert.valid_to), trusted: socket.authorized, ...(trustError ? { trustError } : {}) })
    })
    socket.once('timeout', () => finish({ error: 'timed out' }))
    socket.once('error', (error: NodeJS.ErrnoException) => finish({ error: error.message }))
  })
}

/** open(2) with O_NOFOLLOW: a symlink at `path` is an error that says so. */
async function openNoFollow(path: string, flags: number) {
  try {
    return await open(path, flags | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'EMLINK') throw new Error(`${path} is a symbolic link — refused, never followed`)
    if (code === 'ENOTDIR') throw new Error(`${path} is not a directory`)
    throw error
  }
}

/** `mkdir -p` of the parent, for writers that create a file in a directory that may not exist. */
export const parentOf = (path: string) => dirname(path)
