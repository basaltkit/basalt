import { join } from 'node:path'
import type { ComposeRuntime } from './config.js'
import { DeployError, type DeployContext, type Finding } from './context.js'
import { listeners } from './ports.js'

/**
 * The Docker Compose runtime (RFC 0006 §13.2): images built once per commit
 * and tagged `<tag>:<sha>`, `compose up -d` with those tags, a rollback that
 * reuses the images of an earlier release instead of rebuilding them.
 *
 * Only the configured image tags (C4: `<app>` or `<app>-…`) and the project
 * named after the app are ever touched.
 */

export const composeOf = (ctx: DeployContext): ComposeRuntime => {
  if (ctx.config.runtime.kind !== 'compose') throw new Error('not a compose runtime')
  return ctx.config.runtime
}

/** 7 characters, as `git rev-parse --short` and the scripts before this one: their images stay usable for a rollback. */
const short = (sha: string) => sha.slice(0, 7)

/** Compose's own environment: each image variable → `<tag>:<sha>`, plus `runtime.env`. */
export function composeEnv(ctx: DeployContext, sha: string): Record<string, string> {
  const rt = composeOf(ctx)
  const env: Record<string, string> = { ...rt.env }
  for (const image of rt.images) env[image.env] = `${image.tag}:${short(sha)}`
  return env
}

const composeArgs = (ctx: DeployContext, ...args: string[]) =>
  ['compose', '-p', ctx.config.app, '-f', join(ctx.dir, composeOf(ctx).file), ...args]

interface ServiceState { service: string; state: string; health: string; publishers: number[] }

/** `docker compose ps` of the project, one entry per container. */
export async function composeServices(ctx: DeployContext, sha: string): Promise<ServiceState[] | undefined> {
  const result = await ctx.host.exec('docker', composeArgs(ctx, 'ps', '--all', '--format', 'json'), { cwd: ctx.dir, env: composeEnv(ctx, sha) })
  if (result.code !== 0) return undefined
  // Compose prints one JSON object per line (v2.21+) or a single array (older).
  const text = result.stdout.trim()
  if (!text) return []
  const rows: Array<Record<string, unknown>> = text.startsWith('[')
    ? JSON.parse(text) as Array<Record<string, unknown>>
    : text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  return rows.map((row) => ({
    service: String(row['Service'] ?? ''),
    state: String(row['State'] ?? ''),
    health: String(row['Health'] ?? ''),
    publishers: (Array.isArray(row['Publishers']) ? row['Publishers'] as Array<{ PublishedPort?: number }> : [])
      .map((p) => Number(p.PublishedPort ?? 0)).filter((port) => port > 0),
  }))
}

export async function composePreflight(ctx: DeployContext, sha: string): Promise<Finding[]> {
  const rt = composeOf(ctx)
  const findings: Finding[] = []
  if (!(await ctx.host.exists(join(ctx.dir, rt.file)))) {
    return [{ id: 'compose', level: 'error', message: `the compose file ${rt.file} does not exist` }]
  }
  const config = await ctx.host.exec('docker', composeArgs(ctx, 'config', '--quiet'), { cwd: ctx.dir, env: composeEnv(ctx, sha) })
  if (config.code !== 0) {
    findings.push({ id: 'compose', level: 'error', message: `docker compose rejects ${rt.file}: ${config.stderr.trim().split('\n')[0] ?? ''}` })
  } else {
    findings.push(...await nameFindings(ctx, sha))
  }
  // C1 under compose: the published port belongs to docker-proxy (root), so a
  // listener with no visible pid is not foreign by itself — it is ours when
  // the upstream service of THIS project publishes it.
  const port = rt.upstream.port
  if ((await listeners(ctx.host)).some((l) => l.port === port)) {
    const services = await composeServices(ctx, sha)
    const ours = services?.some((s) => s.service === rt.upstream.service && s.publishers.includes(port))
    if (!ours) {
      findings.push({
        id: 'C1',
        level: 'error',
        message: `port ${port} (runtime.upstream.port) is taken by something that is not the "${rt.upstream.service}" service of the ${ctx.config.app} project`,
        fix: 'pick another: "port": <n> in /etc/basalt/<app>.json, and publish the same in the compose file',
      })
    }
  }
  return findings
}

/**
 * Every service and container the config names exists — names no type can
 * know. An unknown one is an error that lists the ones that do exist.
 */
async function nameFindings(ctx: DeployContext, sha: string): Promise<Finding[]> {
  const rt = composeOf(ctx)
  const listed = await ctx.host.exec('docker', composeArgs(ctx, 'config', '--services'), { cwd: ctx.dir, env: composeEnv(ctx, sha) })
  const services = listed.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  if (listed.code !== 0 || services.length === 0) return []
  const findings: Finding[] = []
  const named: Array<[string, string]> = [
    ['runtime.upstream.service', rt.upstream.service],
    ...(rt.jobs ?? []).map((j): [string, string] => ['runtime.jobs[].service', j.service]),
    ...Object.keys(ctx.config.verify?.logs ?? {}).map((s): [string, string] => ['verify.logs', s]),
  ]
  for (const [where, name] of named) {
    if (services.includes(name)) continue
    const near = services.find((s) => s.startsWith(name.slice(0, 3)) || name.startsWith(s.slice(0, 3)))
    findings.push({ id: 'compose', level: 'error', message: `${where}: "${name}" is not a service of ${rt.file}${near ? ` — did you mean "${near}"?` : ''} (services: ${services.join(', ')})` })
  }
  for (const container of Object.keys(rt.attach ?? {})) {
    const state = await ctx.host.exec('docker', ['inspect', '--format', '{{.State.Running}}', container])
    if (state.stdout.trim() !== 'true') {
      findings.push(state.code === 0
        ? { id: 'compose', level: 'error', message: `runtime.attach: ${container} is not running`, fix: `docker start ${container}` }
        : { id: 'compose', level: 'error', message: `runtime.attach: ${container} does not exist` })
    }
  }
  return findings
}

/**
 * Containers the project does not own, on its networks (RFC 0007 §4.3). The
 * networks exist once the project does: on a fresh server it is created first
 * (`up --no-start`), with this commit's images.
 */
export async function attachContainers(ctx: DeployContext, sha: string): Promise<string[]> {
  const attach = composeOf(ctx).attach ?? {}
  const pairs = Object.entries(attach).flatMap(([container, networks]) => networks.map((n) => ({ container, network: `${ctx.config.app}_${n}` })))
  if (pairs.length === 0) return []
  const exists = async (network: string) => (await ctx.host.exec('docker', ['network', 'inspect', network, '--format', '{{range .Containers}}{{.Name}} {{end}}'])).code === 0
  const missing: string[] = []
  for (const network of new Set(pairs.map((p) => p.network))) if (!(await exists(network))) missing.push(network)
  if (missing.length > 0) {
    const created = await ctx.host.exec('docker', composeArgs(ctx, 'up', '--no-start'), { cwd: ctx.dir, env: composeEnv(ctx, sha) })
    if (created.code !== 0) throw new DeployError(`creating the ${ctx.config.app} project for its networks (${missing.join(', ')}): ${created.stderr.trim().split('\n')[0] ?? ''}`)
  }
  const connected: string[] = []
  for (const { container, network } of pairs) {
    const members = await ctx.host.exec('docker', ['network', 'inspect', network, '--format', '{{range .Containers}}{{.Name}} {{end}}'])
    if (members.code !== 0) throw new DeployError(`network ${network} does not exist — is "${network.slice(ctx.config.app.length + 1)}" a network of ${composeOf(ctx).file}?`)
    if (members.stdout.split(/\s+/).includes(container)) continue
    const connect = await ctx.host.exec('docker', ['network', 'connect', network, container])
    if (connect.code !== 0) throw new DeployError(`docker network connect ${network} ${container}: ${connect.stderr.trim().split('\n')[0] ?? ''}`)
    connected.push(`${container} → ${network}`)
  }
  return connected.length ? [`attached: ${connected.join(', ')}`] : []
}

/**
 * Volumes the compose file declares `external` (data meant to outlive the
 * project, e.g. ClamAV signatures) are created empty when missing — compose
 * refuses to start, or to run a job, without them.
 */
export async function externalVolumes(ctx: DeployContext, sha: string): Promise<string[]> {
  const config = await ctx.host.exec('docker', composeArgs(ctx, 'config', '--format', 'json'), { cwd: ctx.dir, env: composeEnv(ctx, sha) })
  if (config.code !== 0) return []
  let parsed: { volumes?: Record<string, { external?: boolean; name?: string }> } = {}
  try { parsed = JSON.parse(config.stdout) as typeof parsed } catch { return [] }
  const created: string[] = []
  for (const [key, volume] of Object.entries(parsed.volumes ?? {})) {
    if (!volume.external) continue
    const name = volume.name ?? key
    if ((await ctx.host.exec('docker', ['volume', 'inspect', name])).code === 0) continue
    const made = await ctx.host.exec('docker', ['volume', 'create', name])
    if (made.code !== 0) throw new DeployError(`docker volume create ${name}: ${made.stderr.trim().split('\n')[0] ?? ''}`)
    created.push(name)
  }
  return created.length ? [`external volume(s) created: ${created.join(', ')}`] : []
}

/** The one-off jobs, before `up` (RFC 0007 §4.4); a failure stops the release before anything is replaced. */
export async function runJobs(ctx: DeployContext, sha: string): Promise<string[]> {
  const lines: string[] = []
  for (const job of composeOf(ctx).jobs ?? []) {
    if (job.once) {
      const seen = await ctx.host.exec('docker', composeArgs(ctx, 'run', '--rm', '--no-deps', '--entrypoint', 'sh', job.service, '-c', `ls ${job.once.exists}`), { cwd: ctx.dir, env: composeEnv(ctx, sha) })
      if (seen.code === 0) { lines.push(`job ${job.service}: already done (${job.once.exists})`); continue }
    }
    ctx.host.out.info(`docker compose run --rm ${job.service}${job.command ? ` ${job.command.join(' ')}` : ''}`)
    const ran = await ctx.host.exec('docker', composeArgs(ctx, 'run', '--rm', '--no-deps', job.service, ...(job.command ?? [])), { cwd: ctx.dir, env: composeEnv(ctx, sha), stream: true })
    if (ran.code !== 0) throw new DeployError(`job ${job.service} failed (exit ${ran.code})`)
    lines.push(`job ${job.service}: done`)
  }
  return lines
}

/** `docker build` of every image not built yet for this commit. */
export async function composeBuild(ctx: DeployContext, sha: string): Promise<void> {
  const rt = composeOf(ctx)
  for (const image of rt.images) {
    const ref = `${image.tag}:${short(sha)}`
    if ((await ctx.host.exec('docker', ['image', 'inspect', ref])).code === 0) {
      ctx.host.out.info(`${ref} already built`)
      continue
    }
    ctx.host.out.info(`docker build -f ${image.dockerfile} -t ${ref} ${image.context ?? '.'}`)
    const built = await ctx.host.exec('docker', ['build', '-f', join(ctx.dir, image.dockerfile), '-t', ref, join(ctx.dir, image.context ?? '.')], { cwd: ctx.dir, stream: true })
    if (built.code !== 0) throw new DeployError(`docker build of ${ref} failed (exit ${built.code})`)
  }
}

export async function composeRelease(ctx: DeployContext, sha: string): Promise<string> {
  const rt = composeOf(ctx)
  for (const image of rt.images) {
    const ref = `${image.tag}:${short(sha)}`
    if ((await ctx.host.exec('docker', ['image', 'inspect', ref])).code !== 0) throw new DeployError(`the image ${ref} does not exist — nothing to start`)
  }
  for (const line of [...await externalVolumes(ctx, sha), ...await attachContainers(ctx, sha), ...await runJobs(ctx, sha)]) ctx.host.out.ok(line)
  const up = await ctx.host.exec('docker', composeArgs(ctx, 'up', '-d'), { cwd: ctx.dir, env: composeEnv(ctx, sha), stream: true })
  if (up.code !== 0) throw new DeployError(`docker compose up failed (exit ${up.code})`)
  return `${ctx.config.app} project up on ${short(sha)} (${rt.images.map((i) => i.tag).join(', ')})`
}

/**
 * The upstream service healthy by its own healthcheck (or running, when it
 * declares none), and no service of the project restarting — the ingest
 * worker once crash-looped through a whole deploy unnoticed.
 */
export async function composeHealthy(ctx: DeployContext, sha: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const rt = composeOf(ctx)
  const deadline = ctx.host.now().getTime() + (ctx.config.health?.timeoutSeconds ?? 240) * 1000
  let last = 'no container'
  do {
    const services = await composeServices(ctx, sha) ?? []
    const upstream = services.filter((s) => s.service === rt.upstream.service)
    const restarting = [...new Set(services.filter((s) => s.state === 'restarting').map((s) => s.service))]
    if (restarting.length > 0) return { ok: false, why: `restarting: ${restarting.join(', ')}` }
    const ready = upstream.length > 0 && upstream.every((s) => s.state === 'running' && (s.health === '' || s.health === 'healthy'))
    if (ready) return { ok: true }
    last = upstream.length === 0 ? 'no container' : upstream.map((s) => s.health || s.state).join(', ')
    await ctx.host.sleep(5000)
  } while (ctx.host.now().getTime() < deadline)
  return { ok: false, why: `${rt.upstream.service}: ${last} after ${ctx.config.health?.timeoutSeconds ?? 240}s` }
}

/** Removes `<tag>:<sha>` of the configured images for commits outside `keep`. Nothing else. */
export async function pruneImages(ctx: DeployContext, keep: string[]): Promise<string[]> {
  const rt = composeOf(ctx)
  const keepTags = new Set(keep.map(short))
  const removed: string[] = []
  for (const image of rt.images) {
    const listed = await ctx.host.exec('docker', ['image', 'ls', image.tag, '--format', '{{.Tag}}'])
    if (listed.code !== 0) continue
    for (const tag of listed.stdout.split('\n').map((t) => t.trim()).filter(Boolean)) {
      if (!/^[0-9a-f]{7,40}$/.test(tag) || keepTags.has(tag)) continue
      const rm = await ctx.host.exec('docker', ['image', 'rm', `${image.tag}:${tag}`])
      if (rm.code === 0) removed.push(`${image.tag}:${tag}`)
    }
  }
  return removed
}

/** Text from `verify.logs` in a service's logs since `since` (RFC 0007 §6). */
export async function logFindings(ctx: DeployContext, sha: string, since: Date): Promise<string[]> {
  const problems: string[] = []
  for (const [service, patterns] of Object.entries(ctx.config.verify?.logs ?? {})) {
    const logs = await ctx.host.exec('docker', composeArgs(ctx, 'logs', '--no-color', '--since', since.toISOString(), service), { cwd: ctx.dir, env: composeEnv(ctx, sha) })
    const text = `${logs.stdout}${logs.stderr}`
    const found = patterns.filter((p) => text.includes(p))
    if (found.length > 0) {
      const line = text.split('\n').find((l) => found.some((p) => l.includes(p)))?.trim() ?? ''
      problems.push(`${service} logs ${found.join(', ')}: ${line.slice(0, 200)}`)
    }
  }
  return problems
}

export async function composeStatus(ctx: DeployContext, sha: string): Promise<string[]> {
  const services = await composeServices(ctx, sha)
  if (services === undefined) return [`compose project ${ctx.config.app}: docker compose is not available`]
  if (services.length === 0) return [`compose project ${ctx.config.app}: no containers`]
  return services.map((s) => `${s.service}: ${s.state}${s.health ? ` (${s.health})` : ''}`)
}
