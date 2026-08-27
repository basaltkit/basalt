import {
  detectProject,
  fixableIds,
  hasErrors,
  planFix,
  runDoctor,
  type Diagnostic,
} from '@basaltkit/ai/analysis'
import { DiagnosticSchema, toJsonSchema } from '@basaltkit/ai/schema'
import type { McpToolDef } from '@basaltkit/mcp-core'
import { resolveWorkspaceRoot, type Session } from '../session.js'

/** A preview of an auto-fix — the files it *would* touch. Never applied at M1. */
interface FixPreview {
  id: string
  status: string
  message: string
  files: string[]
}

interface DoctorReport {
  diagnostics: Diagnostic[]
  hasErrors: boolean
  fixes: FixPreview[]
}

const inputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    workspaceRoot: {
      type: 'string',
      description: 'Absolute path to the Basalt project to diagnose. Defaults to the server workspace root.',
    },
  },
}

const outputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    diagnostics: { type: 'array', items: toJsonSchema(DiagnosticSchema) },
    hasErrors: { type: 'boolean' },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['ready', 'noop', 'unfixable'] },
          message: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'status', 'message', 'files'],
      },
    },
  },
  required: ['diagnostics', 'hasErrors', 'fixes'],
}

/**
 * `basalt_doctor` — diagnose configuration, security and tenancy issues, and
 * PREVIEW the available auto-fixes (the files each would change). Read-only:
 * `planFix` computes edits in memory; nothing is written to disk.
 */
export function doctorTool(session: Session): McpToolDef {
  return {
    name: 'basalt_doctor',
    description:
      'Diagnose configuration, security and tenancy issues, and preview the available auto-fixes (which files each would change). Read-only — computes edits in memory, never writes to disk.',
    inputSchema,
    outputSchema,
    async invoke(args) {
      const root = resolveWorkspaceRoot(session, args['workspaceRoot'])
      const reader = session.reader(root)
      const ctx = detectProject(root, reader)
      const diagnostics = runDoctor(ctx)
      const firing = new Set(diagnostics.map((d) => d.id))
      const read = (rel: string): string | null => reader.read(rel)
      const fixes: FixPreview[] = fixableIds()
        .filter((id) => firing.has(id))
        .map((id) => planFix(id, ctx, read))
        .map((outcome) => ({
          id: outcome.id,
          status: outcome.status,
          message: outcome.message,
          files: outcome.edits.map((edit) => edit.path),
        }))
      const report: DoctorReport = { diagnostics, hasErrors: hasErrors(diagnostics), fixes }
      return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
        structuredContent: report,
      }
    },
  }
}
