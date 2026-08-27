import { detectProject } from '@basaltkit/ai/analysis'
import { createPlan, type ArchitecturePlan, type CreatePlanOptions } from '@basaltkit/ai/workflows'
import { ArchitecturePlanSchema, toJsonSchema } from '@basaltkit/ai/schema'
import type { McpToolDef } from '@basaltkit/mcp-core'
import { resolveWorkspaceRoot, type Session } from '../session.js'
import { forwardProgress, isAbortError, providerHelp, toolError } from './errors.js'

const inputSchema: Record<string, unknown> = {
  type: 'object',
  required: ['request'],
  properties: {
    request: { type: 'string', description: 'What to build, in natural language.' },
    workspaceRoot: {
      type: 'string',
      description: 'Absolute path to the Basalt project. Defaults to the server workspace root.',
    },
    temperature: { type: 'number', description: 'Sampling temperature (0 = deterministic).' },
    maxTokens: { type: 'integer', description: 'Hard cap on output tokens.' },
  },
}

/**
 * `basalt_plan` — turn a natural-language request into a grounded BasaltKit
 * architecture plan. Read-only (produces a plan, changes nothing). Requires an
 * AI provider; streams progress and honours cancellation via the tool context.
 */
export function planTool(session: Session): McpToolDef {
  return {
    name: 'basalt_plan',
    description:
      'Turn a natural-language request into a grounded BasaltKit architecture plan (entities, steps, permissions, audit events). Read-only — no file writes. Requires an AI provider (AI_API_KEY / AI_PROVIDER).',
    inputSchema,
    outputSchema: toJsonSchema(ArchitecturePlanSchema),
    async invoke(args, ctx) {
      const request = typeof args['request'] === 'string' ? args['request'].trim() : ''
      if (!request) return toolError('basalt_plan requires a non-empty "request".')

      let provider
      try {
        provider = session.provider()
      } catch (error) {
        return toolError(providerHelp(error, 'basalt_plan'))
      }

      const root = resolveWorkspaceRoot(session, args['workspaceRoot'])
      const projectCtx = detectProject(root, session.reader(root))

      const options: CreatePlanOptions = {
        signal: ctx.signal,
        onProgress: forwardProgress(ctx, 'Planning…'),
      }
      if (typeof args['temperature'] === 'number') options.temperature = args['temperature']
      if (typeof args['maxTokens'] === 'number') options.maxTokens = args['maxTokens']

      ctx.progress?.({ message: 'Planning…' })
      try {
        const plan: ArchitecturePlan = await createPlan(provider, projectCtx, request, options)
        return { content: [{ type: 'text', text: JSON.stringify(plan, null, 2) }], structuredContent: plan }
      } catch (error) {
        if (isAbortError(error)) return toolError('Cancelled.')
        return toolError(error instanceof Error ? error.message : String(error))
      }
    },
  }
}
