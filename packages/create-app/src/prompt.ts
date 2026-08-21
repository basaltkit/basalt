import { emitKeypressEvents } from 'node:readline'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

/** A selectable option. `value` is returned; `label`/`hint` are shown. */
export interface Choice<T> {
  value: T
  label: string
  hint?: string
}

/**
 * The prompt surface the wizard talks to. Abstracted so the flow (`runWizard`)
 * is testable with a scripted implementation — the raw-mode TTY version is the
 * thin, untested I/O shell.
 */
export interface Prompter {
  intro(message: string): void
  note(message: string): void
  outro(message: string): void
  text(opts: { message: string; placeholder?: string; initial?: string; validate?: (v: string) => string | undefined }): Promise<string>
  select<T>(opts: { message: string; choices: Choice<T>[]; initial?: number }): Promise<T>
  multiselect<T>(opts: { message: string; choices: Choice<T>[]; initial?: T[] }): Promise<T[]>
  confirm(opts: { message: string; initial?: boolean }): Promise<boolean>
}

/** Thrown when the user aborts (Ctrl+C, or declines the final confirmation). */
export class WizardCancelledError extends Error {
  constructor() {
    super('Cancelled.')
    this.name = 'WizardCancelledError'
  }
}

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

/**
 * A rich, dependency-free terminal prompter: arrow-key `select`/`multiselect`
 * (raw mode), validated `text`, and `confirm`. Only usable in a TTY.
 */
export function ttyPrompter(): Prompter {
  return {
    intro: (message) => stdout.write(`\n${c.bold(c.cyan('◆ ' + message))}\n\n`),
    note: (message) => stdout.write(`${message}\n`),
    outro: (message) => stdout.write(`\n${c.green('✓ ' + message)}\n`),

    async text({ message, placeholder, initial, validate }) {
      const rl = createInterface({ input: stdin, output: stdout })
      rl.on('SIGINT', () => {
        rl.close()
        throw new WizardCancelledError()
      })
      try {
        for (;;) {
          const hint = placeholder ? c.dim(` (${placeholder})`) : ''
          const answer = (await rl.question(`${c.cyan('?')} ${message}${hint}: `)).trim() || initial || ''
          const error = validate?.(answer)
          if (!error) return answer
          stdout.write(`  ${c.dim(error)}\n`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ABORT_ERR') throw new WizardCancelledError()
        throw error
      } finally {
        rl.close()
      }
    },

    select({ message, choices, initial = 0 }) {
      return keyboardSelect(message, choices, initial, false).then((v) => v[0] as never)
    },

    multiselect({ message, choices, initial = [] }) {
      const preselected = choices.map((choice) => initial.includes(choice.value))
      return keyboardSelect(message, choices, 0, true, preselected)
    },

    async confirm({ message, initial = false }) {
      const rl = createInterface({ input: stdin, output: stdout })
      try {
        const answer = (await rl.question(`${c.cyan('?')} ${message} ${c.dim(initial ? '(Y/n)' : '(y/N)')} `))
          .trim()
          .toLowerCase()
        return answer ? answer.startsWith('y') : initial
      } finally {
        rl.close()
      }
    },
  }
}

/**
 * Shared arrow-key picker for select (returns one value) and multiselect
 * (space toggles, enter confirms — returns the chosen values).
 */
function keyboardSelect<T>(
  message: string,
  choices: Choice<T>[],
  initialIndex: number,
  multi: boolean,
  selected: boolean[] = choices.map(() => false),
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    let index = initialIndex
    let rendered = 0
    emitKeypressEvents(stdin)
    const wasRaw = stdin.isTTY ? stdin.isRaw : false
    if (stdin.isTTY) stdin.setRawMode(true)

    const render = () => {
      if (rendered > 0) stdout.write(`\x1b[${rendered}A\x1b[0J`)
      const lines = [`${c.cyan('?')} ${message}${multi ? c.dim(' (space to toggle, enter to confirm)') : ''}`]
      choices.forEach((choice, i) => {
        const pointer = i === index ? c.cyan('❯') : ' '
        const box = multi ? (selected[i] ? c.green('◉') : '◯') + ' ' : ''
        const label = i === index ? c.cyan(choice.label) : choice.label
        const hint = choice.hint ? c.dim(` — ${choice.hint}`) : ''
        lines.push(`${pointer} ${box}${label}${hint}`)
      })
      stdout.write(lines.join('\n') + '\n')
      rendered = lines.length
    }

    const cleanup = () => {
      stdin.off('keypress', onKey)
      if (stdin.isTTY) stdin.setRawMode(wasRaw)
      stdin.pause()
    }

    const onKey = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup()
        reject(new WizardCancelledError())
      } else if (key.name === 'up' || key.name === 'k') {
        index = (index - 1 + choices.length) % choices.length
        render()
      } else if (key.name === 'down' || key.name === 'j') {
        index = (index + 1) % choices.length
        render()
      } else if (multi && key.name === 'space') {
        selected[index] = !selected[index]
        render()
      } else if (key.name === 'return') {
        cleanup()
        resolve(
          multi
            ? choices.filter((_, i) => selected[i]).map((choice) => choice.value)
            : [choices[index]!.value],
        )
      }
    }

    stdin.resume()
    stdin.on('keypress', onKey)
    render()
  })
}

/**
 * A scripted prompter for tests: each call dequeues the next answer of its kind.
 * `log` captures intro/note/outro lines so a test can assert the summary.
 */
export function scriptedPrompter(script: {
  text?: string[]
  select?: unknown[]
  multiselect?: unknown[][]
  confirm?: boolean[]
}): Prompter & { log: string[] } {
  const text = [...(script.text ?? [])]
  const select = [...(script.select ?? [])]
  const multiselect = [...(script.multiselect ?? [])]
  const confirm = [...(script.confirm ?? [])]
  const log: string[] = []
  const next = <T>(queue: T[], kind: string): T => {
    if (queue.length === 0) throw new Error(`scriptedPrompter: no more ${kind} answers`)
    return queue.shift() as T
  }
  return {
    log,
    intro: (m) => log.push(m),
    note: (m) => log.push(m),
    outro: (m) => log.push(m),
    async text() {
      return next(text, 'text')
    },
    async select() {
      return next(select, 'select') as never
    },
    async multiselect() {
      return next(multiselect, 'multiselect') as never
    },
    async confirm() {
      return next(confirm, 'confirm')
    },
  }
}
