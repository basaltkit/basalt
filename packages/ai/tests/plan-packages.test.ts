import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  aiCommands,
  BASALT_KNOWLEDGE,
  buildPlanContext,
  detectProject,
  ECOSYSTEM_PACKAGES,
  memoryReader,
  parsePlan,
  renderPlan,
  runMake,
  type ArchitecturePlan,
} from '../src/index.js'
import { packageSteps } from '../src/make/make.js'

const PACKAGES_DIR = fileURLToPath(new URL('../../', import.meta.url))

/** Monorepo package directory by npm name. */
function packageDir(name: string): string | undefined {
  for (const dir of readdirSync(PACKAGES_DIR)) {
    const manifest = join(PACKAGES_DIR, dir, 'package.json')
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return join(PACKAGES_DIR, dir)
  }
  return undefined
}

/** Every .ts source under a package's src/, concatenated. */
function sourceOf(dir: string): string {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.ts')) out.push(readFileSync(path, 'utf8'))
    }
  }
  walk(join(dir, 'src'))
  return out.join('\n')
}

describe('ecosystem catalog', () => {
  it.each(ECOSYSTEM_PACKAGES.map((p) => [p.name, p] as const))('%s matches the monorepo', (_name, pkg) => {
    const dir = packageDir(pkg.name)
    expect(dir, `${pkg.name} is not a package in packages/`).toBeDefined()
    const source = sourceOf(dir!)
    for (const entry of [pkg.plugin, pkg.routes].filter((e): e is string => e !== undefined)) {
      expect(source, `${pkg.name} does not export ${entry}`).toMatch(new RegExp(`export (async )?(const|function) ${entry}\\b`))
    }
    if (pkg.prisma) expect(packageDir(pkg.prisma), `${pkg.prisma} is not a package`).toBeDefined()
  })

  it('reaches the planner prompt with the ecosystem-first rule', () => {
    expect(BASALT_KNOWLEDGE).toContain('ECOSYSTEM FIRST')
    expect(BASALT_KNOWLEDGE).toContain('- @basaltkit/comments — ')
    expect(BASALT_KNOWLEDGE).toContain('commentsPlugin + commentRoutes()')
    expect(BASALT_KNOWLEDGE).toContain('"kind": "package"|')
  })
})

describe('plan context', () => {
  it('lists the installed catalog packages, not their store packages', () => {
    const ctx = detectProject(
      '/proj',
      memoryReader({
        'package.json': JSON.stringify({
          dependencies: { '@basaltkit/comments': '^2.0.0', '@basaltkit/comments-prisma': '^1.0.0', '@basaltkit/prisma': '^4.0.0' },
        }),
      }),
    )
    expect(buildPlanContext(ctx)).toContain('INSTALLED ECOSYSTEM PACKAGES: @basaltkit/comments — ')
  })

  it('says so when none is installed', () => {
    const ctx = detectProject('/proj', memoryReader({ 'package.json': JSON.stringify({ dependencies: {} }) }))
    expect(buildPlanContext(ctx)).toContain('INSTALLED ECOSYSTEM PACKAGES: (none)')
  })
})

const tagsPlan: ArchitecturePlan = {
  request: 'tags on posts, with comments',
  summary: 'Tag resource; comments come from @basaltkit/comments',
  entities: [{ name: 'Tag', fields: [{ name: 'label', type: 'String' }], tenantScoped: false }],
  steps: [
    { order: 1, title: 'Install comments', kind: 'package', detail: 'wire commentsPlugin + commentRoutes() in src/app.ts', command: 'pnpm add @basaltkit/comments' },
    { order: 2, title: 'Scaffold Tag', kind: 'generator', detail: 'vertical', command: 'basalt make:resource Tag' },
  ],
  permissions: [],
  auditEvents: [],
  tenantScoped: false,
  warnings: [],
}

describe('package steps', () => {
  it('survive parsing as their own kind', () => {
    const plan = parsePlan(JSON.stringify(tagsPlan), tagsPlan.request)
    expect(plan.steps[0]?.kind).toBe('package')
  })

  it('lead ai:make follow-ups, which never install anything', async () => {
    const ctx = detectProject('/proj', memoryReader({ 'package.json': JSON.stringify({ dependencies: {} }) }))
    const result = await runMake(ctx, tagsPlan, { dryRun: true, baseDir: '/proj' })
    expect(result.resources.map((r) => r.name)).toEqual(['Tag'])
    expect(result.followUps[0]).toBe(
      'Install comments — `pnpm add @basaltkit/comments`: wire commentsPlugin + commentRoutes() in src/app.ts',
    )
  })

  it('explain a plan that has nothing to generate', async () => {
    const ctx = detectProject('/proj', memoryReader({ 'package.json': JSON.stringify({ dependencies: {} }) }))
    const onlyPackages = { ...tagsPlan, entities: [], steps: [tagsPlan.steps[0]!] }
    expect(packageSteps(onlyPackages)).toHaveLength(1)
    await expect(runMake(ctx, onlyPackages, { dryRun: true })).rejects.toThrow(/reuses ecosystem packages\. Install comments/)
  })
})

describe('renderPlan', () => {
  it('points at ai:make with the same request', () => {
    const lines: string[] = []
    renderPlan(tagsPlan, { log: (line: string) => lines.push(line) })
    expect(lines.at(-1)).toBe('Next: basalt ai:make "tags on posts, with comments" implements it.')
  })
})

describe('plans without entities', () => {
  const wiringOnly: ArchitecturePlan = {
    request: 'crie um modulo de email',
    summary: '@basaltkit/mailer is installed; only wire it',
    entities: [],
    steps: [{ order: 1, title: 'Register mailerPlugin', kind: 'other', detail: 'in src/app.ts' }],
    permissions: [],
    auditEvents: [],
    tenantScoped: false,
    warnings: [],
  }

  it('renderPlan does not send them to ai:make', () => {
    const lines: string[] = []
    renderPlan(wiringOnly, { log: (line: string) => lines.push(line) })
    expect(lines.at(-1)).toBe('Nothing for ai:make to generate — the steps above are applied by hand.')
  })

  it('ai:make stops before the confirmation prompt, exit 0', async () => {
    vi.stubEnv('AI_PROVIDER', 'openai')
    vi.stubEnv('AI_API_KEY', 'test')
    vi.stubEnv('AI_BASE_URL', 'http://gateway.test/v1')
    vi.stubEnv('AI_STREAM', 'false')
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(wiringOnly) } }] })))
    try {
      const make = aiCommands({ cwd: '/nonexistent' }).find((c) => c.name === 'ai:make')!
      const logs: string[] = []
      let asked = false
      const io = {
        log: (line: string) => logs.push(line),
        error: (line: string) => logs.push(`ERR ${line}`),
        table: () => {},
        confirm: async () => ((asked = true), true),
      }
      const code = await make.handle({ app: {} as never, container: {} as never, io, args: [wiringOnly.request], flags: {} })
      expect(code).toBe(0)
      expect(asked).toBe(false)
      expect(logs).toContain('Nothing to scaffold — the steps above are applied by hand.')
      expect(logs.join('\n')).not.toMatch(/Next: basalt ai:make/)
    } finally {
      vi.unstubAllEnvs()
      vi.unstubAllGlobals()
    }
  })
})
