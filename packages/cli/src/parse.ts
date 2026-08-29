export interface ParsedArgv {
  command: string | undefined
  args: string[]
  flags: Record<string, string | boolean>
}

/**
 * Minimal argv parser: first bare word is the command; `--key=value` and
 * `--flag` become flags.
 *
 * A bare `--no-<name>` is the conventional **negation**: it sets
 * `flags['<name>'] = false`, not `flags['no-<name>'] = true`. That is what makes
 * documented opt-outs like `basalt dev --no-routes` actually take effect —
 * commands test `flags['routes'] !== false`. Only the bare form negates:
 * `--no-cache=x` still parses as the literal key `no-cache`.
 */
export function parseArgv(argv: string[]): ParsedArgv {
  let command: string | undefined
  const args: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (const token of argv) {
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq === -1) {
        if (body.startsWith('no-') && body.length > 3) flags[body.slice(3)] = false
        else flags[body] = true
      } else flags[body.slice(0, eq)] = body.slice(eq + 1)
    } else if (command === undefined) {
      command = token
    } else {
      args.push(token)
    }
  }
  return { command, args, flags }
}
