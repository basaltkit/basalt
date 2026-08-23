import { serveMcpStdio } from '@basaltkit/mcp'
import { buildApp } from './app.js'

/**
 * The playground as a local MCP server over stdio — point Claude Desktop (or any
 * MCP client) at `tsx src/mcp-stdio.ts`. Logging is silenced because stdout is
 * the JSON-RPC channel; anything else printed there corrupts the protocol.
 */
const app = await buildApp({ logLevel: 'silent' }).boot()

serveMcpStdio(app)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    await app.shutdown()
    process.exit(0)
  })
}
