#!/usr/bin/env node
import { createAiMcpServer } from './server.js'

/** Read a `--name=value` flag from argv. */
function flag(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

const cwd = flag('cwd') ?? process.cwd()

// Provider keys (M2+) come from the launching client's `env` block; the read-only
// M1 tools need none. The stdio server holds the stdin listener open, so the
// process stays alive until the client closes the stream.
createAiMcpServer({ cwd })
