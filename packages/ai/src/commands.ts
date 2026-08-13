import { defineCommand, type CommandDefinition } from '@basaltkit/cli'
import { analyze } from './analyze/run.js'
import { detectProject, nodeReader } from './context/project.js'
import { hasErrors, runDoctor } from './doctor/run.js'
import { applyFixEdits, fixableIds, planFix, renderFixes, type FixOutcome } from './doctor/fixes.js'
import { createProvider, providerEnvFromProcess } from './provider/factory.js'
import { createPlan } from './plan/plan.js'
import { renderPlan } from './plan/render.js'
import { runMake } from './make/make.js'
import { renderMakeResult } from './make/render.js'
import { runPrismaPush } from './make/schema.js'
import { verifyProject } from './make/verify.js'
import { reviewImplementation } from './review/review.js'
import { renderAgentReview } from './review/render.js'
import { renderAnalysis, renderDoctor } from './render.js'

export interface AiCommandsOptions {
  /** Project root to analyze. Defaults to the current working directory. */
  cwd?: string
}

/**
 * CLI commands for the AI-native DX (foundation phase):
 *
 * - `basalt ai`          — overview: detected stack + what the agent can do
 * - `basalt ai:analyze`  — static analysis report (read-only, offline)
 * - `basalt ai:doctor`   — diagnostics with fixes (read-only, offline; exits 1 on errors)
 * - `basalt ai:fix`      — apply a doctor fix, or all auto-fixable ones (offline; --dry-run/--yes)
 * - `basalt ai:plan`     — natural language → architecture plan (read-only; needs a provider)
 * - `basalt ai:make`     — plan then implement: scaffold + domain fields, review gate (writes; needs a provider)
 *
 * Wire them in like the generator commands:
 * `commandsPlugin([...generatorCommands(), ...aiCommands()])`.
 */
export function aiCommands(options: AiCommandsOptions = {}): CommandDefinition[] {
  const rootOf = (flags: Record<string, string | boolean>): string =>
    typeof flags['dir'] === 'string' ? flags['dir'] : options.cwd ?? process.cwd()

  return [
    defineCommand({
      name: 'ai',
      description: 'AI-native DX overview: detected stack and available commands',
      handle({ args, flags, io }) {
        const ctx = detectProject(rootOf(flags))
        const report = analyze(ctx)
        renderAnalysis(report, io)
        io.log('')
        if (args.length > 0) {
          io.log(`You asked: "${args.join(' ')}"`)
          io.log('Natural-language planning & scaffolding (ai:plan / ai:make) land in the next phase.')
          io.log('')
        }
        io.log('Available now:')
        io.log('  basalt ai:analyze          Static analysis report')
        io.log('  basalt ai:doctor           Diagnostics with suggested fixes')
        io.log('  basalt ai:fix [id]         Apply an auto-fixable diagnostic')
        io.log('  basalt ai:plan "<request>" Architecture plan from a description')
        io.log('  basalt ai:make "<request>" Plan + implement (scaffold + review gate)')
        return 0
      },
    }),

    defineCommand({
      name: 'ai:analyze',
      description: 'Analyze the project: stack, data model and diagnostics (read-only)',
      handle({ flags, io }) {
        const ctx = detectProject(rootOf(flags))
        renderAnalysis(analyze(ctx), io)
        return 0
      },
    }),

    defineCommand({
      name: 'ai:doctor',
      description: 'Diagnose configuration, security and tenancy issues (read-only)',
      handle({ flags, io }) {
        const ctx = detectProject(rootOf(flags))
        const diagnostics = runDoctor(ctx)
        renderDoctor(diagnostics, io)
        // Non-zero exit on errors so CI can gate on `basalt ai:doctor`.
        return hasErrors(diagnostics) ? 1 : 0
      },
    }),

    defineCommand({
      name: 'ai:fix',
      description: 'Apply a doctor fix (or all auto-fixable issues). --dry-run to preview, --yes to skip confirm',
      async handle({ args, flags, io }) {
        const root = rootOf(flags)
        const ctx = detectProject(root)
        const read = (rel: string): string | null => nodeReader(root).read(rel)
        const id = args[0]

        let outcomes: FixOutcome[]
        if (id) {
          outcomes = [planFix(id, ctx, read)]
        } else {
          // No id: fix every currently-firing rule that has an auto-fixer.
          const firing = new Set(runDoctor(ctx).map((d) => d.id))
          const targets = fixableIds().filter((f) => firing.has(f))
          if (targets.length === 0) {
            io.log('Nothing to auto-fix. Run `basalt ai:doctor` for the full picture.')
            return 0
          }
          outcomes = targets.map((f) => planFix(f, ctx, read))
        }

        renderFixes(outcomes, io)
        const ready = outcomes.filter((o) => o.status === 'ready')
        if (ready.length === 0) {
          // Nothing to write; exit 1 only if the user asked for an unfixable id.
          return id && outcomes[0]?.status === 'unfixable' ? 1 : 0
        }

        if (flags['dry-run'] === true) {
          io.log('')
          io.log('Dry run — nothing written.')
          return 0
        }
        if (flags['yes'] !== true) {
          const ok = await io.confirm(`Apply ${ready.length} fix(es)?`)
          if (!ok) {
            io.log('Aborted — nothing changed.')
            return 0
          }
        }
        for (const outcome of ready) await applyFixEdits(outcome.edits, root)
        io.log('')
        io.log(`✓ Applied ${ready.length} fix(es). Review the changes and restart the server.`)
        return 0
      },
    }),

    defineCommand({
      name: 'ai:plan',
      description: 'Turn a natural-language request into an architecture plan (read-only)',
      async handle({ args, flags, io }) {
        const request = args.join(' ').trim()
        if (!request) {
          io.error('Usage: basalt ai:plan "<what you want to build>"')
          return 1
        }
        let provider
        try {
          provider = createProvider(providerEnvFromProcess())
        } catch (error) {
          io.error(`ai:plan needs an AI provider — ${(error as Error).message}`)
          io.error('Set AI_API_KEY (AI_PROVIDER=anthropic) or run Ollama locally (AI_PROVIDER=ollama).')
          return 1
        }
        const ctx = detectProject(rootOf(flags))
        io.log('Planning...')
        io.log('')
        try {
          const plan = await createPlan(provider, ctx, request)
          renderPlan(plan, io)
          return 0
        } catch (error) {
          io.error((error as Error).message)
          return 1
        }
      },
    }),

    defineCommand({
      name: 'ai:make',
      description: 'Plan then implement a feature: scaffold + domain fields, with a review gate',
      async handle({ args, flags, io }) {
        const request = args.join(' ').trim()
        if (!request) {
          io.error('Usage: basalt ai:make "<what to build>" [--dry-run] [--yes] [--force] [--migrate|--no-migrate] [--review] [--verify]')
          return 1
        }
        let provider
        try {
          provider = createProvider(providerEnvFromProcess())
        } catch (error) {
          io.error(`ai:make needs an AI provider — ${(error as Error).message}`)
          io.error('Set AI_API_KEY (AI_PROVIDER=anthropic) or run Ollama locally (AI_PROVIDER=ollama).')
          return 1
        }
        const baseDir = rootOf(flags)
        const ctx = detectProject(baseDir)

        io.log('Planning...')
        io.log('')
        let plan
        try {
          plan = await createPlan(provider, ctx, request)
        } catch (error) {
          io.error((error as Error).message)
          return 1
        }
        renderPlan(plan, io)
        io.log('')

        // Agent review over the generated code — read-only, uses the same provider.
        const agentReview = async (result: Awaited<ReturnType<typeof runMake>>): Promise<boolean> => {
          if (flags['review'] !== true) return true
          io.log('')
          io.log('Reviewing (agent)...')
          io.log('')
          try {
            const verdict = await reviewImplementation(provider, plan, result)
            renderAgentReview(verdict, io)
            return verdict.approved
          } catch (error) {
            io.error(`Review inconclusive — ${(error as Error).message}`)
            return true // don't block the build on a review hiccup
          }
        }

        const dryRun = flags['dry-run'] === true
        if (dryRun) {
          const result = await runMake(ctx, plan, { dryRun: true, baseDir })
          renderMakeResult(result, io)
          return (await agentReview(result)) ? 0 : 1
        }

        // Safety: writes require confirmation unless --yes (spec §10).
        if (flags['yes'] !== true) {
          const ok = await io.confirm('Implement this plan? Files will be created and src/app.ts wired.')
          if (!ok) {
            io.log('Aborted — nothing was changed.')
            return 0
          }
        }

        io.log('')
        io.log('Implementing...')
        io.log('')
        let result
        try {
          result = await runMake(ctx, plan, {
            baseDir,
            force: flags['force'] === true,
            // --migrate, or --yes (pre-consented), runs prisma db push inside runMake.
            migrate: flags['migrate'] === true || flags['yes'] === true,
          })
        } catch (error) {
          io.error((error as Error).message)
          return 1
        }
        renderMakeResult(result, io)

        // The step most often forgotten: without db push the Prisma client has no
        // delegate for the new model, so every route 500s. Offer it right here.
        if (
          !result.migration &&
          result.schema?.found &&
          flags['no-migrate'] !== true &&
          result.resources.some((r) => r.prisma)
        ) {
          io.log('')
          const ok = await io.confirm(
            'Run `prisma db push` now to create the table(s) + regenerate the Prisma client? (the routes 500 until you do)',
          )
          if (ok) {
            io.log('Running prisma db push...')
            const push = await runPrismaPush(baseDir)
            io.log(
              push.ok
                ? '✓ prisma db push done — restart the dev server to load the regenerated client.'
                : `✗ prisma db push failed:\n${push.output}`,
            )
            if (!push.ok) return 1
          } else {
            io.log('Skipped — run `npx prisma db push` and restart the server before using the routes.')
          }
        }

        const approved = await agentReview(result)

        if (flags['verify'] === true) {
          io.log('')
          io.log('Verifying (typecheck)...')
          const verdict = await verifyProject(baseDir)
          if (verdict.ok) {
            io.log(`✓ ${verdict.command} passed`)
          } else {
            io.error(`✗ ${verdict.command} failed:`)
            io.error(verdict.output)
            return 1
          }
        }

        return result.review.ok && approved ? 0 : 1
      },
    }),
  ]
}
