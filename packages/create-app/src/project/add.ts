import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { basaltBin } from '../bin-template.js'
import {
  collectDependencies,
  resolveFileVersions,
  resolveLatestVersions,
  type ResolveLatestOptions,
  type VersionResolution,
} from '../latest-versions.js'
import {
  appTs,
  BASALT_PROJECT_SCRIPT,
  gitignore,
  mcpJson,
  pnpmWorkspaceYaml,
  readme,
  readmeCliSection,
  readmeMcpSection,
  readmeUiSection,
  routesTs,
  versionOf,
  webDevScript,
  type ProjectOptions,
} from '../templates.js'
import { uiFiles } from '../templates-ui.js'
import type { ProjectContext } from './context.js'
import { createManifest, extendManifest, isPristine, MANIFEST_PATH, serializeManifest } from './manifest.js'
import { mergePackageJson } from './package-json.js'

/**
 * `create-basalt add <feature>`: give an existing app what the matching
 * scaffold flag would have generated, adapted to the app as it is now.
 *
 * Rules: an existing file is never overwritten (skipped with a notice;
 * `--force` overwrites); package.json, pnpm-workspace.yaml, .gitignore and the
 * README are MERGED; user-owned code (src/app.ts, src/routes.ts) is
 * regenerated only when the manifest proves it untouched, patched only where
 * the template's anchors are still unambiguous, and otherwise left alone with
 * the exact manual steps. Planning writes nothing — {@link applyAddPlan} does.
 */

export const ADDABLE_FEATURES = ['ui', 'cli', 'mcp'] as const
export type AddableFeature = (typeof ADDABLE_FEATURES)[number]

export interface PlannedChange {
  path: string
  /** create: new file · overwrite: --force over an existing file · update: merged/patched · skip: left alone. */
  action: 'create' | 'overwrite' | 'update' | 'skip'
  /** Content to write (absent for skip). */
  content?: string
  /** Why (shown next to the path). */
  note?: string
}

export interface AddPlan {
  feature: AddableFeature
  /** The app's options once the feature is on. */
  options: ProjectOptions
  changes: PlannedChange[]
  /** Steps printed for the user (code that could not be edited safely). */
  manual: string[]
  /** Informational lines (versions resolved, things kept). */
  notes: string[]
  /** Set when there is nothing to do (the feature is already there). */
  alreadyPresent?: string
  versions?: VersionResolution
}

export interface AddOptions {
  force?: boolean
  /** Resolve the latest versions from the registry (default true; false = bundled ranges). */
  resolveLatest?: boolean
  registry?: ResolveLatestOptions
}

export class AddRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AddRefusedError'
  }
}

async function readOptional(dir: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(join(dir, path), 'utf8')
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Safe edits of user-owned files

/** Ensures pnpm-workspace.yaml lists `member` under `packages:`; undefined when the shape is not one we can edit. */
export function addWorkspaceMember(yaml: string, member: string): string | undefined {
  const packages = /^packages:[ \t]*(.*)$/m.exec(yaml)
  if (!packages) return `packages:\n  - ${member}\n${yaml}`
  if ((packages[1] ?? '').trim() !== '') return undefined // flow style (packages: [a, b]) — leave to the user
  const after = yaml.slice(packages.index + packages[0].length)
  const items = /^((?:\n[ \t]+-.*|\n[ \t]*#.*)*)/.exec(after)?.[1] ?? ''
  const listed = items
    .split('\n')
    .map((line) => /^\s*-\s*['"]?([^'"#\s]+)['"]?/.exec(line)?.[1])
    .filter((entry): entry is string => entry !== undefined)
  if (listed.includes(member) || listed.includes(`${member}/`)) return yaml
  const indent = /\n([ \t]+)-/.exec(items)?.[1] ?? '  '
  const end = packages.index + packages[0].length + items.length
  return `${yaml.slice(0, end)}\n${indent}- ${member}${yaml.slice(end)}`
}

/** Appends missing ignore lines (`node_modules/` also matches an existing `node_modules` or `/node_modules/`). */
export function ensureGitignore(text: string, lines: readonly string[]): string {
  const normalize = (line: string): string => line.trim().replace(/^\//, '').replace(/\/$/, '')
  const present = new Set(text.split(/\r?\n/).map(normalize))
  const missing = lines.filter((line) => !present.has(normalize(line)))
  if (missing.length === 0) return text
  const separator = text === '' || text.endsWith('\n') ? '' : '\n'
  return `${text}${separator}${missing.join('\n')}\n`
}

const ADAPTER_LINE = /^([ \t]*)(fastifyPlugin|expressPlugin|honoPlugin)\(\{ routes: (.+) \}\)(,?)[ \t]*$/gm

/** The single adapter-plugin line (`fastifyPlugin|expressPlugin|honoPlugin({ routes: … })`), or undefined when absent/ambiguous. */
function adapterLine(source: string): RegExpExecArray | undefined {
  const matches = [...source.matchAll(ADAPTER_LINE)]
  return matches.length === 1 ? (matches[0] as RegExpExecArray) : undefined
}

/** Inserts an import line before the first import of the file. */
function addImport(source: string, line: string): string | undefined {
  const first = /^import /m.exec(source)
  if (!first) return undefined
  return `${source.slice(0, first.index)}${line}\n${source.slice(first.index)}`
}

/**
 * Wires `commandsPlugin` into a scaffold-shaped src/app.ts (any adapter):
 * the import, `commands?: CommandDefinition[]` on BuildAppOptions, and the
 * plugin right before the adapter. Undefined when an anchor is missing or
 * ambiguous — the caller prints manual steps instead.
 */
export function patchAppForCli(source: string): string | undefined {
  if (source.includes('commandsPlugin(')) return source
  if (!/export function buildApp\(options: BuildAppOptions = \{\}\)/.test(source)) return undefined
  const options = /export interface BuildAppOptions \{\n([\s\S]*?)\n\}/.exec(source)
  const adapter = adapterLine(source)
  if (!options || !adapter) return undefined
  const indent = adapter[1] ?? ''
  let out =
    source.slice(0, adapter.index) +
    `${indent}...(options.commands && options.commands.length > 0 ? [commandsPlugin(options.commands)] : []),\n` +
    source.slice(adapter.index)
  out = out.replace(
    options[0],
    `export interface BuildAppOptions {\n${options[1]}\n  /** Dev/CLI commands (make:*, ai:*, prisma:sync) — passed ONLY by bin/basalt.ts. */\n  commands?: CommandDefinition[]\n}`,
  )
  return addImport(out, `import { commandsPlugin, type CommandDefinition } from '@basaltkit/cli'`)
}

/** `value` as a single-quoted TS string literal (backslashes, quotes and line breaks escaped). */
function singleQuoted(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n')}'`
}

/**
 * Wires the MCP server into a scaffold-shaped src/app.ts (any adapter):
 * `mcpPlugin({ routes: <the adapter's routes> })` before the adapter, and
 * `...mcpRoutes()` appended to the adapter's routes.
 */
export function patchAppForMcp(source: string, name: string): string | undefined {
  if (source.includes('mcpPlugin(')) return source
  const adapter = adapterLine(source)
  if (!adapter) return undefined
  const [line, indent = '', plugin, routes = '', comma = ''] = adapter
  const expression = routes.trim()
  let withMcp: string
  if (/^\[[\s\S]*\]$/.test(expression)) withMcp = `${expression.slice(0, -1)}, ...mcpRoutes()]`
  else if (/^[\w$.]+(\(\))?$/.test(expression)) withMcp = `[...${expression}, ...mcpRoutes()]`
  else return undefined
  const replacement =
    `${indent}mcpPlugin({ routes: ${expression}, serverInfo: { name: ${singleQuoted(name)}, version: '0.1.0' } }),\n` +
    `${indent}${plugin}({ routes: ${withMcp} })${comma}`
  const out = source.slice(0, adapter.index) + replacement + source.slice(adapter.index + line.length)
  return addImport(out, `import { mcpPlugin, mcpRoutes } from '@basaltkit/mcp'`)
}

// ---------------------------------------------------------------------------
// Planning

/** Ranges for packages a feature adds to the ROOT package.json (latest, or the bundled ranges). */
async function rootRanges(
  wanted: Record<string, string>,
  options: AddOptions,
): Promise<{ ranges: Record<string, string>; versions?: VersionResolution }> {
  if (options.resolveLatest === false) return { ranges: wanted }
  const versions = await resolveLatestVersions(collectDependencies([JSON.stringify({ dependencies: wanted })]), options.registry)
  return { ranges: versions.versions, versions }
}

interface Builder {
  ctx: ProjectContext
  force: boolean
  changes: PlannedChange[]
  manual: string[]
  notes: string[]
  /** Content create-basalt writes in full (manifest hashes them). */
  generated: Record<string, string>
}

/** A whole generated file: created, skipped when present, overwritten with --force. */
async function plannedFile(b: Builder, path: string, content: string): Promise<void> {
  const existing = await readOptional(b.ctx.dir, path)
  if (existing === undefined) {
    b.changes.push({ path, action: 'create', content })
    b.generated[path] = content
  } else if (existing === content) {
    b.changes.push({ path, action: 'skip', note: 'already identical' })
  } else if (b.force) {
    b.changes.push({ path, action: 'overwrite', content, note: '--force' })
    b.generated[path] = content
  } else {
    b.changes.push({ path, action: 'skip', note: 'exists — kept yours (--force to overwrite)' })
  }
}

/** A merged edit of an existing file (or its creation when absent). */
function plannedEdit(b: Builder, path: string, before: string | undefined, after: string, note: string): void {
  if (before === after) return
  b.changes.push({ path, action: before === undefined ? 'create' : 'update', content: after, note })
  // A file create-basalt wrote and nobody touched stays "pristine" after our edit.
  if (before === undefined || isPristine(b.ctx.manifest, path, before)) b.generated[path] = after
}

/**
 * A user-owned source file (src/app.ts, src/routes.ts): regenerated when the
 * manifest proves it untouched, else patched by `patch`, else manual steps.
 */
async function plannedSource(
  b: Builder,
  path: string,
  regenerate: (() => string) | undefined,
  patch: (source: string) => string | undefined,
  manual: string,
): Promise<void> {
  const existing = await readOptional(b.ctx.dir, path)
  if (existing === undefined) {
    b.manual.push(`${path} does not exist. ${manual}`)
    return
  }
  if (regenerate && isPristine(b.ctx.manifest, path, existing)) {
    plannedEdit(b, path, existing, regenerate(), 'untouched template — regenerated with the feature on')
    return
  }
  const patched = patch(existing)
  if (patched === undefined) {
    b.changes.push({ path, action: 'skip', note: 'customised — see the manual steps' })
    b.manual.push(`${path}: ${manual}`)
  } else if (patched !== existing) {
    b.changes.push({ path, action: 'update', content: patched, note: 'patched at the template anchors' })
  }
}

/** README: regenerated when untouched (features line included), else the feature's section appended. */
async function plannedReadme(b: Builder, regenOptions: ProjectOptions | undefined, heading: string, section: string): Promise<void> {
  const current = await readOptional(b.ctx.dir, 'README.md')
  if (current === undefined || current.includes(heading)) return
  if (regenOptions && isPristine(b.ctx.manifest, 'README.md', current)) {
    plannedEdit(b, 'README.md', current, readme(regenOptions), 'untouched template — regenerated with the feature on')
    return
  }
  plannedEdit(b, 'README.md', current, `${current}${current.endsWith('\n') ? '' : '\n'}${section}`, `+ "${heading}" section`)
}

async function plannedPackageJson(
  b: Builder,
  additions: Parameters<typeof mergePackageJson>[1],
): Promise<void> {
  const merged = mergePackageJson(b.ctx.packageJsonText, additions)
  for (const kept of merged.kept) b.notes.push(`package.json: ${kept}`)
  if (merged.text !== b.ctx.packageJsonText) {
    b.changes.push({ path: 'package.json', action: 'update', content: merged.text, note: merged.changes.join('; ') })
  }
}

/** Plans `add <feature>` for the app in `ctx`. Writes nothing. */
export async function planAdd(ctx: ProjectContext, feature: AddableFeature, options: AddOptions = {}): Promise<AddPlan> {
  const present: Record<AddableFeature, boolean> = {
    ui: ctx.options.ui,
    cli: ctx.options.cli,
    mcp: ctx.options.mcp,
  }
  const next: ProjectOptions = { ...ctx.options, [feature]: true }
  const b: Builder = { ctx, force: options.force === true, changes: [], manual: [], notes: [], generated: {} }
  if (present[feature] && !b.force) {
    return {
      feature,
      options: next,
      changes: [],
      manual: [],
      notes: [],
      alreadyPresent: {
        ui: 'web/package.json already exists',
        cli: 'bin/basalt.ts already exists',
        mcp: '@basaltkit/mcp is already a dependency',
      }[feature],
    }
  }
  // Regeneration uses the options the pristine file was generated FROM, with the feature flipped on.
  const regenOptions: ProjectOptions | undefined = ctx.manifest ? { ...ctx.manifest.options, [feature]: true } : undefined
  let versions: VersionResolution | undefined

  if (feature === 'ui') {
    if (ctx.pm !== 'pnpm') {
      throw new AddRefusedError(
        `The web/ frontend is a pnpm workspace member (pnpm-workspace.yaml), and this project uses ${ctx.pm}. Switch the project to pnpm first (or pass --pm=pnpm if it already uses it).`,
      )
    }
    const files = uiFiles(next)
    if (options.resolveLatest !== false) versions = await resolveFileVersions(files, options.registry)
    for (const [path, content] of Object.entries(files)) await plannedFile(b, path, content)
    const yaml = await readOptional(ctx.dir, 'pnpm-workspace.yaml')
    if (yaml === undefined) {
      plannedEdit(b, 'pnpm-workspace.yaml', undefined, pnpmWorkspaceYaml(next), 'web/ as a workspace member')
    } else {
      const patched = addWorkspaceMember(yaml, 'web')
      if (patched === undefined) b.manual.push('pnpm-workspace.yaml: add `web` to `packages:` (it is written in a style this command does not edit).')
      else plannedEdit(b, 'pnpm-workspace.yaml', yaml, patched, 'web/ as a workspace member')
    }
    await plannedPackageJson(b, { scripts: { 'dev:web': webDevScript(next) } })
    const ignore = await readOptional(ctx.dir, '.gitignore')
    plannedEdit(b, '.gitignore', ignore, ignore === undefined ? gitignore(next) : ensureGitignore(ignore, ['node_modules/', 'dist/']), 'ignore web/ build output')
    await plannedReadme(b, regenOptions, '## Web UI', readmeUiSection(next))
    b.notes.push('No CORS change needed: the Vite dev server proxies /api to the API on :3000.')
  }

  if (feature === 'cli') {
    const resolved = await rootRanges(
      {
        '@basaltkit/cli': versionOf('@basaltkit/cli'),
        '@basaltkit/prisma': versionOf('@basaltkit/prisma'),
        '@basaltkit/generator': versionOf('@basaltkit/generator'),
        'create-basalt': versionOf('create-basalt'),
      },
      options,
    )
    versions = resolved.versions
    await plannedFile(b, 'bin/basalt.ts', basaltBin())
    await plannedPackageJson(b, {
      dependencies: {
        '@basaltkit/cli': resolved.ranges['@basaltkit/cli'] as string,
        '@basaltkit/prisma': resolved.ranges['@basaltkit/prisma'] as string,
      },
      devDependencies: {
        '@basaltkit/generator': resolved.ranges['@basaltkit/generator'] as string,
        'create-basalt': resolved.ranges['create-basalt'] as string,
      },
      replaceScripts: { basalt: { from: BASALT_PROJECT_SCRIPT, to: 'tsx bin/basalt.ts' } },
    })
    await plannedSource(
      b,
      'src/app.ts',
      regenOptions ? () => appTs(regenOptions) : undefined,
      patchAppForCli,
      [
        'wire the CLI commands into buildApp by hand:',
        "  1. import { commandsPlugin, type CommandDefinition } from '@basaltkit/cli'",
        '  2. add `commands?: CommandDefinition[]` to the options buildApp(options) accepts',
        '  3. add `...(options.commands && options.commands.length > 0 ? [commandsPlugin(options.commands)] : [])` to its plugins, before the HTTP adapter plugin',
        'bin/basalt.ts calls buildApp({ logLevel, commands }).',
      ].join('\n'),
    )
    await plannedReadme(b, regenOptions, '## The `basalt` CLI', readmeCliSection(next))
  }

  if (feature === 'mcp') {
    const resolved = await rootRanges(
      { '@basaltkit/mcp': versionOf('@basaltkit/mcp'), '@basaltkit/ai-mcp': versionOf('@basaltkit/ai-mcp') },
      options,
    )
    versions = resolved.versions
    await plannedPackageJson(b, {
      dependencies: { '@basaltkit/mcp': resolved.ranges['@basaltkit/mcp'] as string },
      // Dev-only AI bridge — never a runtime dependency.
      devDependencies: { '@basaltkit/ai-mcp': resolved.ranges['@basaltkit/ai-mcp'] as string },
    })
    await plannedFile(b, '.mcp.json', mcpJson(next))
    await plannedSource(
      b,
      'src/app.ts',
      regenOptions ? () => appTs(regenOptions) : undefined,
      (source) => patchAppForMcp(source, next.name),
      [
        'wire the MCP server by hand:',
        "  1. import { mcpPlugin, mcpRoutes } from '@basaltkit/mcp'",
        `  2. add \`mcpPlugin({ routes: <your routes>, serverInfo: { name: '${next.name}', version: '0.1.0' } })\` to the plugins`,
        '  3. append `...mcpRoutes()` to the routes your HTTP adapter plugin serves (POST /mcp)',
      ].join('\n'),
    )
    const routes = await readOptional(ctx.dir, 'src/routes.ts')
    if (routes !== undefined && regenOptions && isPristine(ctx.manifest, 'src/routes.ts', routes)) {
      plannedEdit(b, 'src/routes.ts', routes, routesTs(regenOptions), 'untouched template — overview/health exposed as MCP tools')
    } else {
      b.notes.push(
        "Expose routes as MCP tools by adding `meta: { mcp: { name: '…', description: '…' } }` to read-only routes (none are exposed until you do).",
      )
    }
    await plannedReadme(b, regenOptions, '## MCP server', readmeMcpSection(next))
  }

  // The manifest records what create-basalt wrote (old projects get one now).
  const manifest = ctx.manifest ? extendManifest(ctx.manifest, next, b.generated) : createManifest(next, b.generated)
  const writes = b.changes.some((change) => change.action !== 'skip')
  if (writes) {
    const before = await readOptional(ctx.dir, MANIFEST_PATH)
    plannedEdit(b, MANIFEST_PATH, before, serializeManifest(manifest), 'records the generated files')
    delete b.generated[MANIFEST_PATH]
  }
  return { feature, options: next, changes: b.changes, manual: b.manual, notes: b.notes, ...(versions ? { versions } : {}) }
}
