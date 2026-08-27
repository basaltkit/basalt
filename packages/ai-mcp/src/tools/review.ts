import {
  reviewImplementation,
  type AgentReview,
  type ArchitecturePlan,
  type MakeResult,
  type ReviewOptions,
} from '@basaltkit/ai/workflows'
import { AgentReviewSchema, ArchitecturePlanSchema, MakeResultSchema, toJsonSchema } from '@basaltkit/ai/schema'
import type { McpToolDef } from '@basaltkit/mcp-core'
import { type Session } from '../session.js'
import { forwardProgress, isAbortError, providerHelp, toolError } from './errors.js'

const inputSchema: Record<string, unknown> = {
  type: 'object',
  required: ['plan', 'makeResult'],
  properties: {
    plan: toJsonSchema(ArchitecturePlanSchema),
    makeResult: toJsonSchema(MakeResultSchema),
  },
}

/**
 * `basalt_review` — LLM critique of a build result against its plan (tenancy,
 * security, RBAC, validation, tests, fit). Read-only — it judges, it doesn't
 * edit. Takes the `plan` from `basalt_plan` and the `makeResult` from
 * `basalt_make`. Requires an AI provider.
 */
export function reviewTool(session: Session): McpToolDef {
  return {
    name: 'basalt_review',
    description:
      'Critique a build result against its plan (tenancy, security, RBAC, validation, tests, fit) and return an approve/reject verdict. Read-only. Requires an AI provider.',
    inputSchema,
    outputSchema: toJsonSchema(AgentReviewSchema),
    async invoke(args, ctx) {
      const plan = args['plan'] as ArchitecturePlan | undefined
      const makeResult = args['makeResult'] as MakeResult | undefined
      if (!plan || typeof plan !== 'object') {
        return toolError('basalt_review requires a "plan" object (from basalt_plan).')
      }
      if (!makeResult || typeof makeResult !== 'object') {
        return toolError('basalt_review requires a "makeResult" object (from basalt_make).')
      }

      let provider
      try {
        provider = session.provider()
      } catch (error) {
        return toolError(providerHelp(error, 'basalt_review'))
      }

      const options: ReviewOptions = {
        signal: ctx.signal,
        onProgress: forwardProgress(ctx, 'Reviewing…'),
      }

      ctx.progress?.({ message: 'Reviewing…' })
      try {
        const verdict: AgentReview = await reviewImplementation(provider, plan, makeResult, options)
        return { content: [{ type: 'text', text: JSON.stringify(verdict, null, 2) }], structuredContent: verdict }
      } catch (error) {
        if (isAbortError(error)) return toolError('Cancelled.')
        return toolError(error instanceof Error ? error.message : String(error))
      }
    },
  }
}
