import { analyze, detectProject, type AnalysisReport } from '@basaltkit/ai/analysis'
import { AnalysisReportSchema, toJsonSchema } from '@basaltkit/ai/schema'
import type { McpToolDef } from '@basaltkit/mcp-core'
import type { Session } from '../session.js'
import { readRoot } from './errors.js'

const inputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    workspaceRoot: {
      type: 'string',
      description: 'Path of the Basalt project to analyze — absolute or relative, but inside the server project root (paths outside it are refused). Defaults to the server project root.',
    },
  },
}

/**
 * `basalt_analyze` — static analysis of a Basalt project: detected stack, data
 * model and diagnostics. Read-only and offline: no AI provider, no file writes.
 */
export function analyzeTool(session: Session): McpToolDef {
  return {
    name: 'basalt_analyze',
    description:
      'Analyze the Basalt project: detected stack (HTTP/ORM/tenancy/auth/RBAC/audit/…), data model, and diagnostics. Read-only and offline — no AI provider, no file writes.',
    inputSchema,
    outputSchema: toJsonSchema(AnalysisReportSchema),
    async invoke(args) {
      const resolved = readRoot(session, args['workspaceRoot'])
      if ('refused' in resolved) return resolved.refused
      const root = resolved.root
      const ctx = detectProject(root, session.reader(root))
      const report: AnalysisReport = analyze(ctx)
      return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        structuredContent: report,
      }
    },
  }
}
