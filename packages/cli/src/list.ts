import type { CommandDefinition } from './command.js'

/** The group a command belongs to: its name up to the first `:`, or none. */
export function commandGroup(name: string): string | undefined {
  const at = name.indexOf(':')
  return at > 0 ? name.slice(0, at) : undefined
}

/**
 * `basalt list` as lines: ungrouped commands (`dev`, `routes`, …) first, then
 * one block per `group:` prefix, groups in alphabetical order and commands in
 * registration order within each. The prefix is the only taxonomy — a
 * command an app registers as `report:monthly` gets its own group for free.
 * With `group`, only that block.
 */
export function renderCommandList(commands: CommandDefinition[], group?: string): string[] {
  const shown = group === undefined ? commands : commands.filter((c) => commandGroup(c.name) === group)
  const width = Math.max(0, ...shown.map((c) => c.name.length))
  const row = (c: CommandDefinition): string => `  ${c.name.padEnd(width)}  ${c.description ?? ''}`.trimEnd()

  const ungrouped = shown.filter((c) => commandGroup(c.name) === undefined)
  const groups = new Map<string, CommandDefinition[]>()
  for (const c of shown) {
    const name = commandGroup(c.name)
    if (name !== undefined) groups.set(name, [...(groups.get(name) ?? []), c])
  }

  const lines = ungrouped.map(row)
  for (const name of [...groups.keys()].sort()) {
    if (lines.length > 0) lines.push('')
    lines.push(name, ...groups.get(name)!.map(row))
  }
  return lines
}

/**
 * `basalt help <command>` as lines: the usage line, the description, and the
 * flags when the command declares them.
 */
export function renderCommandHelp(command: CommandDefinition): string[] {
  const lines = [`Usage: basalt ${command.name}${command.usage ? ` ${command.usage}` : ''}`]
  if (command.description) lines.push('', command.description)
  const flags = Object.entries(command.flags ?? {})
  if (flags.length > 0) {
    const width = Math.max(...flags.map(([flag]) => flag.length))
    lines.push('', 'Flags:', ...flags.map(([flag, text]) => `  ${flag.padEnd(width)}  ${text}`))
  }
  return lines
}

/** Every group name, sorted. */
export function commandGroups(commands: CommandDefinition[]): string[] {
  return [...new Set(commands.map((c) => commandGroup(c.name)).filter((g): g is string => g !== undefined))].sort()
}

/** Edit distance (insert, delete, substitute), for "did you mean". */
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]!
}

/**
 * Up to three command names close to a mistyped one, nearest first. Close
 * means a few edits away (scaled to the name's length), or the same action in
 * another group — `migrate` finds `tenant:migrate`.
 */
export function suggestCommands(input: string, names: string[]): string[] {
  const limit = Math.max(2, Math.floor(input.length / 4))
  return [...new Set(names)]
    .map((name) => ({ name, score: name.endsWith(`:${input}`) ? 0 : distance(input, name) }))
    .filter(({ score }) => score <= limit)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map(({ name }) => name)
}
