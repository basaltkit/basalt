import type { PackageManager } from './index.js'
import { WizardCancelledError, type Choice, type Prompter } from './prompt.js'

export type FeatureKey = 'tenancy' | 'auth' | 'billing' | 'ui' | 'cli' | 'mcp'

/** The feature toggles offered in the "custom" preset (and shown in the summary). */
export const FEATURES: Choice<FeatureKey>[] = [
  { value: 'tenancy', label: 'Multi-tenancy', hint: 'per-tenant data isolation' },
  { value: 'auth', label: 'Authentication', hint: 'JWT, sessions, MFA, OAuth' },
  { value: 'billing', label: 'Subscriptions / billing', hint: 'Stripe, Paddle, Lemon Squeezy' },
  { value: 'ui', label: 'Web UI', hint: 'React + shadcn + SDK (pnpm workspace)' },
  { value: 'cli', label: 'basalt CLI', hint: 'code generators + commands' },
  { value: 'mcp', label: 'MCP server', hint: 'expose routes as AI-agent tools (/mcp)' },
]

interface Preset {
  value: string
  label: string
  hint: string
  /** null → let the user pick features (custom). */
  features: FeatureKey[] | null
}

export const PRESETS: Preset[] = [
  { value: 'saas', label: 'SaaS starter', hint: 'tenancy + auth + billing + CLI', features: ['tenancy', 'auth', 'billing', 'cli'] },
  { value: 'api', label: 'API only', hint: 'auth + MCP, no tenancy or UI', features: ['auth', 'mcp'] },
  { value: 'full', label: 'Full stack', hint: 'everything + web UI', features: ['tenancy', 'auth', 'billing', 'ui', 'cli', 'mcp'] },
  { value: 'minimal', label: 'Minimal', hint: 'no batteries, add them later', features: [] },
  { value: 'custom', label: 'Custom', hint: 'pick features yourself', features: null },
]

const PACKAGE_MANAGERS: Choice<PackageManager>[] = [
  { value: 'pnpm', label: 'pnpm', hint: 'recommended' },
  { value: 'npm', label: 'npm' },
  { value: 'yarn', label: 'yarn' },
  { value: 'bun', label: 'bun' },
]

/** Validates a project name as an npm-installable package name. */
export function validateProjectName(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return 'Please enter a project name.'
  if (trimmed.length > 214) return 'Name is too long (max 214 characters).'
  if (!/^(?:@[a-z0-9-~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(trimmed)) {
    return 'Use a valid npm package name (lowercase, no spaces).'
  }
  return undefined
}

export interface WizardResult {
  name: string
  tenancy: boolean
  auth: boolean
  billing: boolean
  ui: boolean
  cli: boolean
  mcp: boolean
  pm: PackageManager
  install: boolean
  git: boolean
}

export interface WizardOptions {
  /** Pre-filled name (from argv) — skips the name prompt when valid. */
  name?: string
  /** Detected package manager, used as the default selection. */
  defaultPm?: PackageManager
}

/**
 * The interactive scaffolding flow. Pure with respect to I/O — it drives the
 * injected {@link Prompter}, so tests script the answers and assert the result.
 * Throws {@link WizardCancelledError} if the user declines the final confirm.
 */
export async function runWizard(prompter: Prompter, options: WizardOptions = {}): Promise<WizardResult> {
  prompter.intro('create-basalt — scaffold a Basalt application')

  const name =
    options.name && !validateProjectName(options.name)
      ? options.name
      : await prompter.text({
          message: 'Project name',
          placeholder: 'my-saas',
          initial: 'my-saas',
          validate: validateProjectName,
        })

  const presetValue = await prompter.select({
    message: 'Choose a starting point',
    choices: PRESETS.map((p) => ({ value: p.value, label: p.label, hint: p.hint })),
    initial: 0,
  })
  const preset = PRESETS.find((p) => p.value === presetValue) ?? PRESETS[0]!

  const featureSet = new Set<FeatureKey>(
    preset.features ??
      (await prompter.multiselect({
        message: 'Select features',
        choices: FEATURES,
        initial: ['tenancy', 'auth'],
      })),
  )

  let pm = await prompter.select({
    message: 'Package manager',
    choices: PACKAGE_MANAGERS,
    initial: Math.max(0, PACKAGE_MANAGERS.findIndex((m) => m.value === (options.defaultPm ?? 'pnpm'))),
  })
  // The web/ frontend is a pnpm workspace member — force pnpm when UI is on.
  if (featureSet.has('ui') && pm !== 'pnpm') {
    prompter.note(`  Note: the Web UI is a pnpm workspace — using pnpm instead of ${pm}.`)
    pm = 'pnpm'
  }

  const install = await prompter.confirm({ message: 'Install dependencies now?', initial: false })
  const git = await prompter.confirm({ message: 'Initialize a git repository?', initial: false })

  const enabled = FEATURES.filter((f) => featureSet.has(f.value)).map((f) => f.label)
  prompter.note(
    `\n  Summary\n` +
      `    name      ${name}\n` +
      `    features  ${enabled.length ? enabled.join(', ') : '(none)'}\n` +
      `    pm        ${pm}\n` +
      `    install   ${install ? 'yes' : 'no'}\n` +
      `    git       ${git ? 'yes' : 'no'}\n`,
  )

  const ok = await prompter.confirm({ message: 'Create project?', initial: true })
  if (!ok) throw new WizardCancelledError()

  return {
    name,
    tenancy: featureSet.has('tenancy'),
    auth: featureSet.has('auth'),
    billing: featureSet.has('billing'),
    ui: featureSet.has('ui'),
    cli: featureSet.has('cli'),
    mcp: featureSet.has('mcp'),
    pm,
    install,
    git,
  }
}
