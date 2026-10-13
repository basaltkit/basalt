import { basename, resolve } from 'node:path'
import { ANSWER_TIMEOUT_SECONDS, type AnswerChannel } from './answers.js'
import type { DeployConfig } from './config.js'
import { DeployError } from './context.js'
import { childSink, eventOutput, learnEnvText, type EventOutput, learnSecrets, urlPasswords, type EventWriter, type Redactor } from './events.js'
import type { ExecOptions, Host, PromptMeta } from './host.js'

/**
 * The machine protocol's host (RFC 0008 §5.1): the real host, with
 *
 * - `out` turned into events;
 * - `prompt` answered from `--answers=stdin` (never from a terminal);
 * - `interactive()` false — stdin is the protocol, not a person;
 * - streamed children piped and wrapped in `log` events, never passed
 *   through; an interactive child refused (it would read the answers);
 * - the `.env` and every child's environment learnt by the redactor before
 *   anything can print their secrets.
 *
 * Files, the lock, the clock, TLS and HTTP are the real host's, unchanged.
 */
export interface JsonSession {
  host: Host
  output: EventOutput
  /** The config is known: its `.env` files and which keys are secrets. */
  watchEnv(config: DeployConfig, dir: string): void
  /** Learns the secrets among key/value pairs (`config` says which keys it declares secret); warns once for each one too short. */
  learn(pairs: Iterable<[string, string]>, config?: DeployConfig): void
  /** Learns a secret answer (called by the answer channel the moment it parses one). */
  secret(key: string, value: string): void
  /** Where the `.env` answers come from (`--answers=stdin`), once the config says what it asks. */
  useAnswers(channel: AnswerChannel): void
}

export function jsonHost(base: Host, writer: EventWriter, redactor: Redactor, options: { answerTimeoutMs?: number } = {}): JsonSession {
  const output = eventOutput(writer)
  const envFiles = new Set<string>()
  const attempts = new Map<string, number>()
  let config: DeployConfig | undefined
  const timeout = options.answerTimeoutMs ?? ANSWER_TIMEOUT_SECONDS * 1000
  let channel: AnswerChannel | undefined

  /** A secret too short to redact is said once, by key (RFC 0008 §6.2). */
  const warnShort = (keys: string[]) => {
    for (const key of keys) {
      output.finding({ id: 'secret-short', level: 'warning', message: `${key} is shorter than 6 characters: --json output cannot redact it`, fix: 'use a longer value (a generated one is 32+ characters)' })
    }
  }
  const learnEnv = (text: string | undefined) => { if (text) warnShort(learnEnvText(redactor, text, config)) }

  const overrides: Partial<Host> = {
    out: output,
    interactive: () => false,
    async readFile(path) {
      const text = await base.readFile(path)
      if (envFiles.has(path)) learnEnv(text)
      return text
    },
    async writeFile(path, content, mode) {
      if (envFiles.has(path)) learnEnv(content)
      return base.writeFile(path, content, mode)
    },
    async exec(command, args, execOptions: ExecOptions = {}) {
      if (execOptions.interactive) {
        throw new DeployError(`${command} would read the terminal, and stdin is the protocol under --json`, [], 'unsupported')
      }
      if (execOptions.env) warnShort(learnSecrets(redactor, Object.entries(execOptions.env), config))
      if (!execOptions.stream) return base.exec(command, args, execOptions)
      const sink = childSink(writer, basename(command), output.current)
      try {
        return await base.exec(command, args, { ...execOptions, onOutput: (text, stream) => sink.push(text, stream) })
      } finally {
        sink.end()
      }
    },
    async prompt(question, { secret }, meta?: PromptMeta) {
      const answers = channel
      if (!answers || !meta) return undefined
      const attempt = (attempts.get(meta.id) ?? 0) + 1
      attempts.set(meta.id, attempt)
      if (attempt > 1) {
        if (!answers.live) {
          throw new DeployError(`${meta.key}: the answer was refused (the warning above says why) — nothing was written`, [], 'answer-invalid', 'answers sent up front get no second chance: correct it and run again')
        }
        answers.expectAgain(meta.id)
      }
      writer.emit({
        type: 'prompt', id: meta.id, kind: secret ? 'secret' : 'text', message: question, key: meta.key,
        optional: meta.optional, attempt,
        ...(!secret && meta.default !== undefined ? { default: meta.default } : {}),
      })
      return (await answers.take(meta.id, timeout))?.trim()
    },
    async confirm(question) {
      // No app-user command confirms; a confirmation is never assumed (RFC 0008 §5.1).
      writer.emit({ type: 'prompt', id: 'confirm', kind: 'confirm', message: question, optional: true, attempt: 1 })
      return false
    },
  }

  const host = new Proxy(base, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property as keyof Host]
      // The real host's own members, called on the real host (`this` is never the proxy).
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })

  return {
    host,
    output,
    useAnswers(next) { channel = next },
    learn(pairs, given) { warnShort(learnSecrets(redactor, pairs, given ?? config)) },
    watchEnv(next, dir) {
      config = next
      envFiles.add(resolve(dir, next.env.file ?? '.env'))
      for (const mirror of next.env.mirror ?? []) envFiles.add(resolve(dir, mirror))
    },
    secret(key, value) {
      const short = [value, ...urlPasswords(value)].some((form) => redactor.add(key, form) === 'short')
      if (short) warnShort([key])
    },
  }
}
