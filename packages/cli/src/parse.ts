export interface ParsedArgv {
  command: string | undefined
  args: string[]
  flags: Record<string, string | boolean>
}

/** Minimal argv parser: first bare word is the command; `--key=value` and `--flag` become flags. */
export function parseArgv(argv: string[]): ParsedArgv {
  let command: string | undefined
  const args: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (const token of argv) {
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq === -1) flags[body] = true
      else flags[body.slice(0, eq)] = body.slice(eq + 1)
    } else if (command === undefined) {
      command = token
    } else {
      args.push(token)
    }
  }
  return { command, args, flags }
}
