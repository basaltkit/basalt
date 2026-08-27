import { analyze, detectProject, runDoctor } from '@basaltkit/ai/analysis'
import type { McpResourceDef } from '@basaltkit/mcp-core'
import type { Session } from '../session.js'

/**
 * Project state as MCP resources — read-only reflections of the workspace the
 * agent can pull as context. Backed by the same detection used by the tools.
 */
export function projectResources(session: Session): McpResourceDef[] {
  const root = session.workspaceRoot
  const context = () => detectProject(root, session.reader(root))
  return [
    {
      uri: 'basalt://project/context',
      name: 'Project context',
      description: 'Detected stack, Prisma models, and app/server/env files at the workspace root.',
      mimeType: 'application/json',
      read() {
        return { text: JSON.stringify(context(), null, 2) }
      },
    },
    {
      uri: 'basalt://project/analysis',
      name: 'Project analysis',
      description: 'Enabled capabilities, data-model summary and diagnostics for the workspace.',
      mimeType: 'application/json',
      read() {
        return { text: JSON.stringify(analyze(context()), null, 2) }
      },
    },
    {
      uri: 'basalt://project/diagnostics',
      name: 'Project diagnostics',
      description: 'Doctor findings (security, tenancy, database, observability, config, …).',
      mimeType: 'application/json',
      read() {
        return { text: JSON.stringify(runDoctor(context()), null, 2) }
      },
    },
  ]
}
