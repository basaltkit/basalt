#!/usr/bin/env node
import { createAiMcpHttpServer, createAiMcpServer } from './server.js'

/** Read a `--name=value` flag from argv. */
function flag(name: string): string | undefined {
  const prefix = `--${name}=`
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  return hit ? hit.slice(prefix.length) : undefined
}

/** True when a bare `--name` flag is present. */
function has(name: string): boolean {
  return process.argv.slice(2).some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`))
}

const cwd = flag('cwd') ?? process.cwd()

// Transport: stdio is the default (the local-dev path). `--http[=port]` opts into
// the minimal HTTP transport for remote/CI. Provider keys come from the launching
// client's `env` block; the read-only tools need none.
if (has('http')) {
  const portFlag = flag('http')
  const port = portFlag ? Number(portFlag) : 0
  const hostFlag = flag('host')
  createAiMcpHttpServer({ cwd, port, ...(hostFlag ? { host: hostFlag } : {}) })
    .then((handle) => process.stdout.write(`basalt-ai-mcp listening on ${handle.url}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`basalt-ai-mcp: failed to start HTTP server — ${(error as Error).message}\n`)
      process.exitCode = 1
    })
} else {
  // The stdio server holds the stdin listener open until the client closes it.
  createAiMcpServer({ cwd })
}
