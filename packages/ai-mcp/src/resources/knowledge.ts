import { BASALT_KNOWLEDGE } from '@basaltkit/ai/analysis'
import type { McpResourceDef } from '@basaltkit/mcp-core'

/**
 * The BasaltKit architectural context as an MCP resource — the same framework
 * conventions and rules the planner is grounded in, so an agent can reason with
 * them directly.
 */
export function knowledgeResources(): McpResourceDef[] {
  return [
    {
      uri: 'basalt://knowledge/architecture',
      name: 'BasaltKit architecture',
      description: 'The framework conventions and architectural rules the planner is grounded in.',
      mimeType: 'text/markdown',
      read() {
        return { text: BASALT_KNOWLEDGE }
      },
    },
  ]
}
