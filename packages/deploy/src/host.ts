import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants, openSync, closeSync } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import tls from 'node:tls'

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
  stat(path: string): Promise<{ kind: 'file' | 'dir' | 'symlink' | 'other'; size: number } | undefined>
  readlink(path: string): Promise<string | undefined>
  symlink(target: string, path: string): Promise<void>
  mkdir(path: string, mode?: number): Promise<void>
  remove(path: string): Promise<void>
  list(dir: string): Promise<string[]>
  /** A line typed by a person, or `undefined` when nobody can answer (no TTY). */
  prompt(question: string, options: { secret: boolean }): Promise<string | undefined>
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
  uid(): number
  out: Output
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
  step(title: string): void
  info(message: string): void
  ok(message: string): void
  warn(message: string): void
  error(message: string): void
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
        const child = spawn(command, args, {
          cwd: options.cwd,
          env,
          stdio: options.stream ? ['ignore', 'inherit', 'inherit'] : ['ignore', fd ?? 'pipe', 'pipe'],
        })
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
        const done = (code: number) => {
          if (fd !== undefined) closeSync(fd)
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
        return { kind, size: s.size }
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
    async mkdir(path, mode) {
      await mkdir(path, { recursive: true, ...(mode === undefined ? {} : { mode }) })
    },
    remove: (path) => rm(path, { force: true, recursive: true }),
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
      if (secret) {
        const writer = rl as unknown as { _writeToOutput: (s: string) => void }
        let asked = false
        writer._writeToOutput = (s: string) => {
          if (!asked) { process.stderr.write(s); asked = true }
        }
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

    tlsCertificate(servername) {
      return new Promise((resolve) => {
        // The chain is verified as for any client: an untrusted or expired
        // certificate fails the handshake and is reported by its code. Only
        // the NAME check is ours — it records the certificate instead of
        // refusing it, because which names it covers is what we report (C8).
        // Nothing is sent over the connection either way.
        let names: string[] = []
        const socket = tls.connect({
          host: servername, port: 443, servername, timeout: 10_000,
          checkServerIdentity: (_host, cert) => {
            names = (cert.subjectaltname ?? '')
              .split(',')
              .map((entry) => entry.trim())
              .filter((entry) => entry.startsWith('DNS:'))
              .map((entry) => entry.slice(4).toLowerCase())
            return undefined
          },
        })
        const finish = (value: TlsCertificate | { error: string }) => { socket.destroy(); resolve(value) }
        socket.once('secureConnect', () => {
          finish({ names, validTo: new Date(socket.getPeerCertificate().valid_to), trusted: true })
        })
        socket.once('timeout', () => finish({ error: 'timed out' }))
        socket.once('error', (error: NodeJS.ErrnoException) => {
          const code = error.code ?? ''
          finish({ error: /CERT|SELF_SIGNED|UNABLE_TO|VERIFY/.test(code) ? `certificate not trusted by browsers (${code})` : error.message })
        })
      })
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

/** `mkdir -p` of the parent, for writers that create a file in a directory that may not exist. */
export const parentOf = (path: string) => dirname(path)
