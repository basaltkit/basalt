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
// Opt-out of the fail-closed apply: only for clients that cannot elicit and a
// user who reviews previews themselves.
const allowUnconfirmedApply = has('allow-unconfirmed-apply')

// Transport: stdio is the default (the local-dev path). `--http[=port]` opts into
// the minimal HTTP transport for remote/CI. Provider keys come from the launching
// client's `env` block; the read-only tools need none.
if (has('http')) {
  const portFlag = flag('http')
  const port = portFlag ? Number(portFlag) : 0
  const hostFlag = flag('host')
  // A non-loopback --host needs a token (serveHttp refuses the bind otherwise).
  const token = flag('token') ?? process.env['BASALT_AI_MCP_TOKEN']
  const allowedHosts = flag('allowed-hosts')?.split(',').map((h) => h.trim()).filter(Boolean)
  createAiMcpHttpServer({
    cwd,
    port,
    allowUnconfirmedApply,
    ...(hostFlag ? { host: hostFlag } : {}),
    // Hostnames clients use to reach a remote bind (the Host header they send).
    ...(allowedHosts ? { allowedHosts } : {}),
    ...(token ? { token } : {}),
  })
    .then((handle) => process.stdout.write(`basalt-ai-mcp listening on ${handle.url}\n`))
    .catch((error: unknown) => {
      const message = (error as Error).message
      const hint = /non-loopback/.test(message) ? ' Pass --token=<secret> (or set BASALT_AI_MCP_TOKEN).' : ''
      process.stderr.write(`basalt-ai-mcp: failed to start HTTP server — ${message}${hint}\n`)
      process.exitCode = 1
    })
} else {
  // The stdio server holds the stdin listener open until the client closes it.
  createAiMcpServer({ cwd, allowUnconfirmedApply })
}
