import { detectProject } from '@basaltkit/ai/analysis'
import { createPlan, runMake, type ArchitecturePlan, type MakeOptions } from '@basaltkit/ai/workflows'
import { ArchitecturePlanSchema, MakeResultSchema, toJsonSchema } from '@basaltkit/ai/schema'
import type { McpToolDef } from '@basaltkit/mcp-core'
import { resolveWriteRoot, assertConfined, WorkspaceEscapeError } from '../safety.js'
import { type Session } from '../session.js'
import { forwardProgress, isAbortError, providerHelp, toolError } from './errors.js'

const inputSchema: Record<string, unknown> = {
  type: 'object',
  properties: {
    plan: toJsonSchema(ArchitecturePlanSchema),
    request: {
      type: 'string',
      description: 'Alternative to `plan`: plan then make in one call (needs an AI provider).',
    },
    workspaceRoot: {
      type: 'string',
      description: 'Project root (must be inside the launch directory). Defaults to the server workspace root.',
    },
    mode: {
      type: 'string',
      enum: ['preview', 'apply'],
      default: 'preview',
      description: 'preview (default) writes nothing and returns per-file diffs + clash flags; apply writes.',
    },
    force: { type: 'boolean', default: false, description: 'Overwrite files that already exist (apply only).' },
    migrate: { type: 'boolean', default: false, description: 'Run `prisma db push` after writing (apply only).' },
  },
  oneOf: [{ required: ['plan'] }, { required: ['request'] }],
}

/**
 * `basalt_make` — implement a plan: scaffold the resource vertical and wire it
 * in. Safe by construction: **preview is the default and writes nothing**;
 * `apply` is explicit; overwrites need `force`; `prisma db push` needs `migrate`;
 * all writes are confined to the workspace; an `apply` is confirmed via
 * elicitation when the client supports it.
 */
export function makeTool(session: Session): McpToolDef {
  return {
    name: 'basalt_make',
    description:
      'Implement a plan: scaffold a resource vertical (schema, repository, service, routes, tests) and wire it into the app. PREVIEW by default — writes nothing and returns per-file diffs + clash flags. Set mode:"apply" to write; overwriting existing files needs force:true; running prisma db push needs migrate:true. All writes are confined to the workspace.',
    inputSchema,
    outputSchema: toJsonSchema(MakeResultSchema),
    async invoke(args, ctx) {
      const mode = args['mode'] === 'apply' ? 'apply' : 'preview'
      const force = args['force'] === true
      const migrate = args['migrate'] === true

      // 1) Confine the write root — reject a workspaceRoot that escapes the launch subtree.
      let root: string
      try {
        root = resolveWriteRoot(session.workspaceRoot, typeof args['workspaceRoot'] === 'string' ? args['workspaceRoot'] : undefined)
      } catch (error) {
        if (error instanceof WorkspaceEscapeError) return toolError(`Refused: ${error.message}`)
        throw error
      }
      const projectCtx = detectProject(root, session.reader(root))

      // 2) Obtain the plan: client-carried (stateless correlation) or planned from a request.
      let plan: ArchitecturePlan
      if (args['plan'] && typeof args['plan'] === 'object') {
        plan = args['plan'] as ArchitecturePlan
      } else if (typeof args['request'] === 'string' && args['request'].trim()) {
        let provider
        try {
          provider = session.provider()
        } catch (error) {
          return toolError(providerHelp(error, 'basalt_make'))
        }
        try {
          plan = await createPlan(provider, projectCtx, args['request'].trim(), {
            signal: ctx.signal,
            onProgress: forwardProgress(ctx, 'Planning…'),
          })
        } catch (error) {
          if (isAbortError(error)) return toolError('Cancelled.')
          return toolError(error instanceof Error ? error.message : String(error))
        }
      } else {
        return toolError('basalt_make requires either a "plan" (from basalt_plan) or a "request" to plan.')
      }

      // 3) Always compute the dry-run preview first (clash flags + diffs), then confine every target path.
      let preview
      try {
        preview = await runMake(projectCtx, plan, {
          dryRun: true,
          baseDir: root,
          signal: ctx.signal,
          onProgress: forwardProgress(ctx, 'Previewing…'),
        })
      } catch (error) {
        if (isAbortError(error)) return toolError('Cancelled.')
        return toolError(error instanceof Error ? error.message : String(error))
      }
      try {
        assertConfined(root, (preview.preview?.perFile ?? []).map((f) => f.path))
      } catch (error) {
        if (error instanceof WorkspaceEscapeError) return toolError(`Refused: ${error.message}`)
        throw error
      }

      if (mode === 'preview') {
        return { content: [{ type: 'text', text: JSON.stringify(preview, null, 2) }], structuredContent: preview }
      }

      // 4) Apply — gated. Clash requires force; a supported client confirms via elicitation.
      const clashes = preview.preview?.clashes ?? []
      if (clashes.length > 0 && !force) {
        return toolError(
          `Refusing to overwrite ${clashes.length} existing file(s) without force:true — ${clashes.join(', ')}. ` +
            'Review the preview, then re-run mode:"apply" with force:true.',
        )
      }
      const fileCount = preview.preview?.perFile.length ?? 0
      const summary =
        `Apply "${plan.request}": write ${fileCount} file(s) under ${root}` +
        `${clashes.length ? ` (overwriting ${clashes.length})` : ''}${migrate ? ' and run prisma db push' : ''}. Proceed?`
      if (ctx.elicit) {
        const confirmed = await ctx.elicit(summary)
        if (!confirmed) return toolError('Apply cancelled — not confirmed.')
      }

      // 5) Real write — force/migrate only as explicitly requested.
      try {
        const makeOptions: MakeOptions = {
          baseDir: root,
          force,
          migrate,
          signal: ctx.signal,
          onProgress: forwardProgress(ctx, 'Implementing…'),
        }
        const result = await runMake(projectCtx, plan, makeOptions)
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result }
      } catch (error) {
        if (isAbortError(error)) return toolError('Cancelled.')
        return toolError(error instanceof Error ? error.message : String(error))
      }
    },
  }
}
