/**
 * Structural mirror of `@basaltkit/cli`'s command contract.
 *
 * `@basaltkit/prisma` is a runtime package; depending on the CLI just to type
 * two command factories would drag the whole CLI module graph (runner, dev,
 * upgrade, builtins) into every production app that uses Prisma repositories —
 * `defineCommand` there is an identity function. The same structural approach
 * is used by @basaltkit/tenancy, queue, scheduler and http.
 *
 * These shapes are deliberately *narrower* than the CLI's (`handle` only asks
 * for what the commands here use), which keeps every command built from them
 * assignable to the CLI's `CommandDefinition` — a compile-time + end-to-end
 * test in `tests/command-contract.test.ts` proves it and fails on drift.
 */

/** What the prisma commands need from the CLI's `CommandIo`. */
export interface CommandIo {
  log(message: string): void
  error(message: string): void
  table(rows: Record<string, unknown>[]): void
  /** Ask a yes/no question. Resolves true only on an explicit yes. */
  confirm(question: string): Promise<boolean>
}

/** What the prisma commands need from the CLI's `CommandContext`. */
export interface CommandContext {
  io: CommandIo
  /** Positional arguments after the command name. */
  args: string[]
  /** Parsed flags: `--key=value` → string, `--flag` → true. */
  flags: Record<string, string | boolean>
}

/** Shape consumed by the CLI's `commandsPlugin` / `'commands'` metadata bucket. */
export interface CommandDefinition {
  /** Command name, by convention `noun:verb` (e.g. `tenant:migrate`). */
  name: string
  description?: string
  handle(context: CommandContext): void | number | Promise<void | number>
}
