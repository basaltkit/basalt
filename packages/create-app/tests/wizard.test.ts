import { describe, expect, it } from 'vitest'
import {
  runWizard,
  scriptedPrompter,
  validateProjectName,
  WizardCancelledError,
} from '../src/index.js'

describe('validateProjectName', () => {
  it('accepts valid npm names', () => {
    expect(validateProjectName('my-saas')).toBeUndefined()
    expect(validateProjectName('acme_app')).toBeUndefined()
    expect(validateProjectName('@scope/app')).toBeUndefined()
  })
  it('rejects empty, spaced, uppercase, or over-long names', () => {
    expect(validateProjectName('  ')).toMatch(/enter a project name/)
    expect(validateProjectName('My App')).toMatch(/valid npm/)
    expect(validateProjectName('UPPER')).toMatch(/valid npm/)
    expect(validateProjectName('x'.repeat(215))).toMatch(/too long/)
  })
})

describe('runWizard', () => {
  it('applies a preset and skips the feature multiselect', async () => {
    const p = scriptedPrompter({
      text: ['acme'],
      select: ['saas', 'pnpm'], // preset, then package manager
      confirm: [false, false, true], // install, git, create?
    })
    const result = await runWizard(p)
    expect(result).toMatchObject({
      name: 'acme',
      tenancy: true,
      auth: true,
      billing: true,
      cli: true,
      ui: false,
      pm: 'pnpm',
      install: false,
      git: false,
    })
    // the summary was rendered
    expect(p.log.join('\n')).toContain('Summary')
  })

  it('lets the custom preset drive a feature multiselect', async () => {
    const p = scriptedPrompter({
      text: ['api-svc'],
      select: ['custom', 'npm'],
      multiselect: [['auth', 'cli']],
      confirm: [true, false, true],
    })
    const result = await runWizard(p)
    expect(result).toMatchObject({ auth: true, cli: true, tenancy: false, billing: false, ui: false, pm: 'npm', install: true })
  })

  it('forces pnpm when the Web UI is selected', async () => {
    const p = scriptedPrompter({
      text: ['full-app'],
      select: ['full', 'npm'], // full preset includes ui; npm chosen
      confirm: [false, false, true],
    })
    const result = await runWizard(p)
    expect(result.ui).toBe(true)
    expect(result.pm).toBe('pnpm') // overridden
    expect(p.log.join('\n')).toContain('using pnpm instead of npm')
  })

  it('skips the name prompt when a valid name is passed in', async () => {
    const p = scriptedPrompter({
      // no text answer queued → would throw if the name prompt ran
      select: ['minimal', 'pnpm'],
      confirm: [false, false, true],
    })
    const result = await runWizard(p, { name: 'preset-named' })
    expect(result.name).toBe('preset-named')
    expect(result.tenancy).toBe(false) // minimal
  })

  it('throws WizardCancelledError when the final confirm is declined', async () => {
    const p = scriptedPrompter({
      text: ['x'],
      select: ['minimal', 'pnpm'],
      confirm: [false, false, false], // decline create
    })
    await expect(runWizard(p)).rejects.toBeInstanceOf(WizardCancelledError)
  })
})
