import { defineCommand, type CommandDefinition } from '@basaltkit/cli'
import { analyze } from './analyze/run.js'
import { detectProject } from './context/project.js'
import { hasErrors, runDoctor } from './doctor/run.js'
import { createProvider, providerEnvFromProcess } from './provider/factory.js'
import { createPlan } from './plan/plan.js'
import { renderPlan } from './plan/render.js'
import { runMake } from './make/make.js'
import { renderMakeResult } from './make/render.js'
import { verifyProject } from './make/verify.js'
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
          io.error('Usage: basalt ai:make "<what to build>" [--dry-run] [--yes] [--force] [--verify]')
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

        const dryRun = flags['dry-run'] === true
        if (dryRun) {
          const result = await runMake(ctx, plan, { dryRun: true, baseDir })
          renderMakeResult(result, io)
          return 0
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
          result = await runMake(ctx, plan, { baseDir, force: flags['force'] === true })
        } catch (error) {
          io.error((error as Error).message)
          return 1
        }
        renderMakeResult(result, io)

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

        return result.review.ok ? 0 : 1
      },
    }),
  ]
}
