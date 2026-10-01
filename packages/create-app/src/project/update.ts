import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { binStatus, MANUAL_BIN_SNIPPET, patchBasaltBin } from '../bin-template.js'
import {
  alwaysLatest,
  lookupLatestVersions,
  minimumReleaseAgeMinutes,
  type LatestInfo,
  type ResolveLatestOptions,
} from '../latest-versions.js'
import { BASALT_PROJECT_SCRIPT } from '../templates.js'
import type { ProjectContext } from './context.js'
import { extendManifest, MANIFEST_PATH, serializeManifest } from './manifest.js'
import {
  DEPENDENCY_SECTIONS,
  mergePackageJson,
  setDependencyRange,
  type DependencySection,
  type PackageJson,
} from './package-json.js'
import { table, type Colors } from './term.js'
import { compareVersions, parseSimpleRange, parseVersion, satisfies, updateKind, type UpdateKind } from './semver.js'

/**
 * `create-basalt update`: move an existing app's dependencies to the latest
 * published versions under the SAME registry policy as a new scaffold
 * (`lookupLatestVersions`, shared with latest-versions.ts):
 *
 * - `@basaltkit/*` and `create-basalt` → the registry's `latest`, across majors
 *   (each framework major is flagged with a pointer to its changelog);
 * - third-party → the newest release on the app's CURRENT major; a newer major
 *   is reported and only taken with `--major`;
 * - a third-party version not provably older than the release-age window
 *   (pnpm `minimumReleaseAge`) keeps the current range — the install would
 *   otherwise refuse it.
 *
 * Planning is pure (no writes); {@link UpdatePlan.files} holds the full
 * before/after of every file the plan would write.
 */

export const DOCS_UPGRADING_URL = 'https://basaltkit-docs.pages.dev/guide/whats-new#upgrading'
const REPO_URL = 'https://github.com/basaltkit/basalt'

/** The CHANGELOG of a framework package in the Basalt repository. */
export function changelogUrl(name: string): string {
  const dir = name === 'create-basalt' ? 'create-app' : name.replace(/^@basaltkit\//, '')
  return `${REPO_URL}/blob/main/packages/${dir}/CHANGELOG.md`
}

export type EntryStatus =
  /** Will be written. */
  | 'update'
  /** Already at latest. */
  | 'current'
  /** Third-party latest is a new major (needs --major). */
  | 'held-major'
  /** Third-party latest is inside the release-age window (or its age is unknown). */
  | 'too-fresh'
  /** The registry did not answer. */
  | 'failed'
  /** A range `update` does not rewrite (workspace:, tags, git, >=, …). */
  | 'unmanaged'
  /** The app is already ahead of `latest` (a pre-release, a local build). */
  | 'ahead'
  /** Filtered out by --only. */
  | 'skipped'

export interface UpdateEntry {
  file: string
  section: DependencySection
  name: string
  current: string
  latest?: string
  /** New range (same style as `current`) when status is `update`. */
  target?: string
  kind?: UpdateKind
  status: EntryStatus
  framework: boolean
  /** For `too-fresh`: proven recent, or age unknown. */
  freshness?: 'recent' | 'unknown'
}

export interface FileWrite {
  before: string | undefined
  after: string
}

export interface UpdatePlan {
  entries: UpdateEntry[]
  /** Entries that change (status `update`). */
  updates: UpdateEntry[]
  /** Every file this plan writes, keyed by project-relative path. */
  files: Record<string, FileWrite>
  /** Project tooling the plan also upgrades (bin/basalt.ts, create-basalt devDependency, …). */
  tooling: string[]
  /** Steps the user has to do by hand (printed, never applied). */
  manual: string[]
  /** Peer-range conflicts and registry failures worth reading before applying. */
  warnings: string[]
  /** Framework packages crossing a major: name → changelog URL. */
  majors: { name: string; from: string; to: string; changelog: string }[]
  registry: string
}

export interface UpdateOptions {
  /** Allow third-party packages to cross a major. */
  major?: boolean
  /** `@basaltkit`: only the framework packages (and create-basalt). */
  only?: 'basaltkit'
  /** Also upgrade project tooling (default true). */
  tooling?: boolean
  registry?: ResolveLatestOptions
}

export class RegistryUnavailableError extends Error {
  constructor(registry: string) {
    super(
      `Could not reach ${registry} for any package — update needs the npm registry. Check your connection (or npm_config_registry) and retry.`,
    )
    this.name = 'RegistryUnavailableError'
  }
}

const isFramework = (name: string): boolean => alwaysLatest(name)

/** `minimumReleaseAge: <n>` from pnpm-workspace.yaml, when set. */
export function workspaceReleaseAge(yaml: string | undefined): number | undefined {
  const match = yaml ? /^minimumReleaseAge:\s*(\d+)\s*$/m.exec(yaml) : null
  return match ? Number(match[1]) : undefined
}

/** Whether pnpm-workspace.yaml's minimumReleaseAgeExclude lists `entry`. */
export function workspaceExcludes(yaml: string | undefined, entry: string): boolean {
  if (!yaml) return false
  const block = /^minimumReleaseAgeExclude:\s*\n((?:[ \t]+-.*\n?|[ \t]*#.*\n?)*)/m.exec(yaml)
  if (!block) return false
  return (block[1] ?? '')
    .split('\n')
    .map((line) => /^\s*-\s*['"]?([^'"#\s]+)['"]?/.exec(line)?.[1])
    .includes(entry)
}

/** Adds `entry` to minimumReleaseAgeExclude right after the `@basaltkit/*` line; undefined when that line is absent. */
export function addWorkspaceExclude(yaml: string, entry: string): string | undefined {
  const line = /^([ \t]+)-[ \t]*['"]?@basaltkit\/\*['"]?[ \t]*$/m.exec(yaml)
  if (!line) return undefined
  const end = line.index + line[0].length
  return `${yaml.slice(0, end)}\n${line[1]}- ${entry}${yaml.slice(end)}`
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

interface Manifest {
  file: string
  text: string
  json: PackageJson
}

export async function planUpdate(ctx: ProjectContext, options: UpdateOptions = {}): Promise<UpdatePlan> {
  const manifests: Manifest[] = [{ file: 'package.json', text: ctx.packageJsonText, json: ctx.packageJson }]
  if (ctx.web) manifests.push({ file: 'web/package.json', text: ctx.web.text, json: ctx.web.json })
  const workspaceYaml = await readOptional(join(ctx.dir, 'pnpm-workspace.yaml'))
  const tooling = options.tooling !== false

  // Every declared dependency, per file and section.
  const entries: UpdateEntry[] = []
  for (const manifest of manifests) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, current] of Object.entries(manifest.json[section] ?? {})) {
        const framework = isFramework(name)
        const status: EntryStatus =
          options.only === 'basaltkit' && !framework ? 'skipped' : parseSimpleRange(current) ? 'update' : 'unmanaged'
        entries.push({ file: manifest.file, section, name, current, status, framework })
      }
    }
  }
  const rootHasCreateBasalt = entries.some((entry) => entry.file === 'package.json' && entry.name === 'create-basalt')
  // Tooling: an app without create-basalt as a devDependency gets one, so
  // `pnpm basalt update` resolves locally next time.
  const addCreateBasalt = tooling && !rootHasCreateBasalt

  const managed = entries.filter((entry) => entry.status === 'update')
  const names = [...new Set([...managed.map((entry) => entry.name), ...(addCreateBasalt ? ['create-basalt'] : [])])].sort()

  // The release-age window and who is exempt from it: the project's own pnpm
  // config decides (non-pnpm managers have no exclude list → nobody exempt).
  const window = minimumReleaseAgeMinutes(options.registry?.minimumReleaseAge ?? workspaceReleaseAge(workspaceYaml))
  const exempt = (name: string): boolean =>
    ctx.pm === 'pnpm' &&
    ((name.startsWith('@basaltkit/') && workspaceExcludes(workspaceYaml, '@basaltkit/*')) ||
      (name === 'create-basalt' &&
        (workspaceExcludes(workspaceYaml, 'create-basalt') ||
          (tooling && workspaceYaml !== undefined && addWorkspaceExclude(workspaceYaml, 'create-basalt') !== undefined))))

  const majorsOf = new Map<string, Set<number>>()
  for (const entry of managed) {
    const range = parseSimpleRange(entry.current)
    if (!range) continue
    const set = majorsOf.get(entry.name) ?? new Set<number>()
    set.add(range.parsed[0])
    majorsOf.set(entry.name, set)
  }
  /** Whether `latest` would be taken for `name` from a range on `major`. */
  const acceptsMajor = (name: string, major: number, latest: string): boolean =>
    isFramework(name) || options.major === true || Number(latest.split('.')[0]) === major

  const { results, registry } = await lookupLatestVersions(
    names,
    (name, latest) =>
      !exempt(name) && (majorsOf.get(name) === undefined || [...(majorsOf.get(name) ?? [])].some((major) => acceptsMajor(name, major, latest))),
    { ...options.registry, minimumReleaseAge: window },
  )
  if (names.length > 0 && names.every((name) => results.get(name)?.latest === undefined)) {
    throw new RegistryUnavailableError(registry)
  }

  for (const entry of managed) {
    const info = results.get(entry.name) as LatestInfo
    const range = parseSimpleRange(entry.current)
    if (!range) continue
    if (info.latest === undefined) {
      entry.status = 'failed'
      continue
    }
    entry.latest = info.latest
    const latest = parseVersion(info.latest)
    if (!latest) {
      entry.status = 'failed'
      continue
    }
    const order = compareVersions(latest, range.parsed)
    if (order === 0) {
      entry.status = 'current'
      continue
    }
    if (order < 0) {
      entry.status = 'ahead'
      continue
    }
    entry.kind = updateKind(range.parsed, latest)
    if (!acceptsMajor(entry.name, range.parsed[0], info.latest)) {
      entry.status = 'held-major'
      continue
    }
    if (info.age !== 'mature') {
      entry.status = 'too-fresh'
      entry.freshness = info.age
      continue
    }
    entry.status = 'update'
    entry.target = `${range.style}${info.latest}`
  }

  const updates = entries.filter((entry) => entry.status === 'update' && entry.target !== undefined)
  const files: Record<string, FileWrite> = {}
  for (const manifest of manifests) {
    let text = manifest.text
    for (const entry of updates.filter((candidate) => candidate.file === manifest.file)) {
      text = setDependencyRange(text, entry.section, entry.name, entry.target as string)
    }
    if (text !== manifest.text) files[manifest.file] = { before: manifest.text, after: text }
  }

  const toolingNotes: string[] = []
  const manual: string[] = []
  const warnings: string[] = []

  if (tooling) {
    // create-basalt devDependency + the `basalt` script that reaches it.
    const createBasaltLatest = results.get('create-basalt')
    const rootText = files['package.json']?.after ?? ctx.packageJsonText
    if (addCreateBasalt && createBasaltLatest?.latest !== undefined) {
      const fresh = createBasaltLatest.age !== 'mature'
      if (fresh) {
        warnings.push(
          `create-basalt ${createBasaltLatest.latest} is inside the release-age window — not added as a devDependency this time.`,
        )
      } else {
        const hasBin = ctx.options.cli
        const merged = mergePackageJson(rootText, {
          devDependencies: { 'create-basalt': `^${createBasaltLatest.latest}` },
          scripts: { basalt: hasBin ? 'tsx bin/basalt.ts' : BASALT_PROJECT_SCRIPT },
        })
        if (merged.changes.length > 0) {
          files['package.json'] = { before: ctx.packageJsonText, after: merged.text }
          toolingNotes.push(
            `package.json: create-basalt ^${createBasaltLatest.latest} as a devDependency${
              merged.changes.some((change) => change.startsWith('scripts:')) ? ' + a "basalt" script' : ''
            } — so \`${ctx.pm === 'npm' ? 'npm run' : ctx.pm} basalt update\` works from now on`,
          )
        }
        if (workspaceYaml !== undefined && !workspaceExcludes(workspaceYaml, 'create-basalt')) {
          const patched = addWorkspaceExclude(workspaceYaml, 'create-basalt')
          if (patched !== undefined) {
            files['pnpm-workspace.yaml'] = { before: workspaceYaml, after: patched }
            toolingNotes.push('pnpm-workspace.yaml: create-basalt joins minimumReleaseAgeExclude (like @basaltkit/*)')
          }
        }
      }
    }

    // bin/basalt.ts from an earlier template: make it delegate the project commands.
    const bin = await readOptional(join(ctx.dir, 'bin', 'basalt.ts'))
    const status = binStatus(bin, ctx.manifest?.files['bin/basalt.ts'])
    if (status === 'patchable' && bin !== undefined) {
      const after = patchBasaltBin(bin)
      files['bin/basalt.ts'] = { before: bin, after }
      toolingNotes.push('bin/basalt.ts: unmodified template from an earlier release — gains update/add/doctor/info')
      if (ctx.manifest) {
        files[MANIFEST_PATH] = {
          before: serializeManifest(ctx.manifest),
          after: serializeManifest(extendManifest(ctx.manifest, ctx.options, { 'bin/basalt.ts': after })),
        }
      }
    } else if (status === 'modified') {
      manual.push(`bin/basalt.ts was customised, so it was not patched. To give it the project commands:\n${MANUAL_BIN_SNIPPET}`)
    }
  }

  // Peer ranges of the framework versions we end up on vs the app's resulting ranges.
  const resulting = new Map<string, string>()
  for (const entry of entries) {
    if (entry.file !== 'package.json' && resulting.has(entry.name)) continue
    resulting.set(entry.name, entry.target ?? entry.current)
  }
  for (const entry of entries) {
    if (!entry.framework || (entry.status !== 'update' && entry.status !== 'current') || entry.file !== 'package.json') continue
    const info = results.get(entry.name)
    for (const [peer, wanted] of Object.entries(info?.peers ?? {})) {
      const range = resulting.get(peer)
      const floor = range ? parseSimpleRange(range) : undefined
      if (!floor) continue
      if (satisfies(floor.version, wanted) === false) {
        const peerEntry = entries.find((candidate) => candidate.name === peer)
        const hint = peerEntry?.status === 'held-major' ? ' — re-run with --major' : ''
        warnings.push(`${entry.name}@${info?.latest} expects ${peer} ${wanted}, but the app will have ${range}${hint}`)
      }
    }
  }
  const failed = entries.filter((entry) => entry.status === 'failed').map((entry) => entry.name)
  if (failed.length > 0) warnings.push(`The registry did not answer for ${[...new Set(failed)].join(', ')} — left unchanged.`)

  const majors = updates
    .filter((entry) => entry.framework && entry.kind === 'major')
    .map((entry) => ({
      name: entry.name,
      from: parseSimpleRange(entry.current)?.version ?? entry.current,
      to: entry.latest as string,
      changelog: changelogUrl(entry.name),
    }))
    .filter((major, i, all) => all.findIndex((other) => other.name === major.name) === i)

  return { entries, updates, files, tooling: toolingNotes, manual, warnings, majors, registry }
}

/** The plan as terminal lines: the update table, then notes, tooling, warnings and majors. */
export function renderUpdatePlan(plan: UpdatePlan, colors: Colors): string[] {
  const lines: string[] = []
  const kindLabel = (kind: UpdateKind | undefined): string =>
    kind === 'major' ? colors.red(colors.bold('MAJOR')) : kind === 'minor' ? colors.yellow('minor') : colors.green('patch')
  const multiFile = new Set(plan.entries.map((entry) => entry.file)).size > 1
  if (plan.updates.length === 0) {
    lines.push(colors.green('Every dependency is already on its latest allowed version.'))
  } else {
    lines.push(colors.bold(`${plan.updates.length} update(s):`), '')
    lines.push(
      ...table(
        ['package', ...(multiFile ? ['in'] : []), 'current', '', 'target', 'kind'],
        plan.updates.map((entry) => [
          entry.framework ? colors.cyan(entry.name) : entry.name,
          ...(multiFile ? [entry.file === 'package.json' ? '.' : entry.file.replace(/\/package\.json$/, '/')] : []),
          entry.current,
          '→',
          colors.bold(entry.target as string),
          kindLabel(entry.kind),
        ]),
        colors,
      ).map((line) => `  ${line}`),
    )
  }
  const held = plan.entries.filter((entry) => entry.status === 'held-major')
  const fresh = plan.entries.filter((entry) => entry.status === 'too-fresh')
  if (held.length > 0 || fresh.length > 0) lines.push('')
  for (const entry of dedupe(held)) {
    lines.push(colors.dim(`  kept ${entry.name} ${entry.current}: ${entry.latest} is a new major — pass --major to take it`))
  }
  for (const entry of dedupe(fresh)) {
    lines.push(
      colors.dim(
        entry.freshness === 'recent'
          ? `  kept ${entry.name} ${entry.current}: ${entry.latest} is inside the release-age window (minimumReleaseAge) — retry later`
          : `  kept ${entry.name} ${entry.current}: could not prove ${entry.latest} is older than the release-age window`,
      ),
    )
  }
  if (plan.majors.length > 0) {
    lines.push('', colors.bold('Framework majors — read before applying:'))
    for (const major of plan.majors) lines.push(`  ${major.name} ${major.from} → ${major.to}: ${major.changelog}`)
    lines.push(`  Upgrade notes: ${DOCS_UPGRADING_URL}`)
  }
  if (plan.tooling.length > 0) {
    lines.push('', colors.bold('Project tooling:'))
    for (const note of plan.tooling) lines.push(`  ${note}`)
  }
  for (const warning of plan.warnings) lines.push('', colors.yellow(`Warning: ${warning}`))
  for (const step of plan.manual) lines.push('', colors.yellow('Manual step:'), step)
  return lines
}

function dedupe(entries: readonly UpdateEntry[]): UpdateEntry[] {
  return entries.filter((entry, i) => entries.findIndex((other) => other.name === entry.name && other.current === entry.current) === i)
}
