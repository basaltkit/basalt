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

export async function composeStatus(ctx: DeployContext, sha: string): Promise<string[]> {
  const services = await composeServices(ctx, sha)
  if (services === undefined) return [`compose project ${ctx.config.app}: docker compose is not available`]
  if (services.length === 0) return [`compose project ${ctx.config.app}: no containers`]
  return services.map((s) => `${s.service}: ${s.state}${s.health ? ` (${s.health})` : ''}`)
}
