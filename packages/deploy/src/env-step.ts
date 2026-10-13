import { basename, dirname, join, resolve } from 'node:path'
import { definedEntries, type DeployConfig, type Question } from './config.js'
import type { DeployContext, Finding } from './context.js'
import { applyEnvChanges, envValues, formatValue, parseEnv, UnwritableValueError, type EnvChange, type EnvDocument } from './dotenv.js'
import type { PromptDescriptor } from './protocol.js'

/**
 * The `.env` step (RFC 0006 §6.1). Order: fixed → generated (only when absent)
 * → derived → infra → asked (only when absent) → forbidden removed.
 *
 * Nothing here prints a value. The summary is keys and reasons only.
 */

export interface EnvPlan {
  document: EnvDocument
  values: Map<string, string>
  changes: EnvChange[]
  /** Keys still to ask — answered by {@link answerQuestions}. */
  questions: string[]
  findings: Finding[]
}

/** The `.env`: relative to the checkout, or absolute (`/etc/<app>/api.env`). */
export const envFile = (ctx: DeployContext) => resolve(ctx.dir, ctx.config.env.file ?? '.env')

/** Its exact copies (`env.mirror`), resolved the same way. */
export const envMirrors = (ctx: DeployContext) => (ctx.config.env.mirror ?? []).map((m) => resolve(ctx.dir, m))

export async function readEnv(ctx: DeployContext): Promise<EnvDocument> {
  return parseEnv((await ctx.host.readFile(envFile(ctx))) ?? '')
}

export function syntaxFindings(document: EnvDocument, file: string): Finding[] {
  return document.problems.map((p) => ({
    id: 'C5',
    level: 'error' as const,
    message: `${file}:${p.line}: ${p.message}`,
    fix: `edit line ${p.line} by hand (KEY=value on one line); the value is not shown here`,
  }))
}

export function planEnv(ctx: DeployContext, document: EnvDocument, port: number, infra: EnvChange[]): EnvPlan {
  const { config } = ctx
  const values = envValues(document)
  const changes: EnvChange[] = []
  const pending = new Map(values)
  const set = (key: string, value: string, reason: string) => {
    if (pending.get(key) === value) return
    const existing = changes.findIndex((c) => c.key === key)
    if (existing !== -1) changes.splice(existing, 1)
    changes.push({ kind: 'set', key, value, reason })
    pending.set(key, value)
  }

  // PM2 runs the app on the host: PORT is where it listens. Under compose the
  // port inside the container is the compose file's business, not the .env's.
  if (config.runtime.kind === 'pm2') set('PORT', String(port), 'the port the process listens on')
  for (const [key, value] of definedEntries(config.env.fixed)) set(key, value, 'fixed in deploy.config.ts')
  for (const [key, spec] of definedEntries(config.env.generate)) {
    if (!pending.get(key)) set(key, ctx.host.randomHex(spec.bytes), 'generated')
  }
  const derived = config.env.derive?.({ app: config.app, domain: config.domain, port }) ?? {}
  for (const [key, value] of definedEntries(derived)) set(key, value, 'derived from the domain/port')
  for (const change of infra) if (change.kind === 'set') set(change.key, change.value, change.reason)

  const questions: string[] = []
  for (const [key, question] of definedEntries(config.env.ask)) {
    const current = pending.get(key)
    if (current === undefined || (current === '' && !question.optional)) questions.push(key)
  }
  for (const key of config.env.forbid ?? []) {
    if (pending.has(key)) changes.push({ kind: 'remove', key, reason: 'forbidden in production by deploy.config.ts' })
  }
  return { document, values, changes, questions, findings: syntaxFindings(document, config.env.file ?? '.env') }
}

/**
 * Asks once, at the terminal (secrets with echo off), or takes the answer from
 * the deploy's own environment under the same name — CI, or a person who
 * prefers `MAILER_URL=… basalt-deploy run`. Returns what is still missing.
 */
export async function answerQuestions(ctx: DeployContext, plan: EnvPlan, options: { secretsNeverDefault?: boolean } = {}): Promise<string[]> {
  const missing: string[] = []
  for (const key of plan.questions) {
    const question = ctx.config.env.ask?.[key]
    if (!question) continue
    let answer = ctx.host.env[key]?.trim()
    for (let attempt = 0; answer === undefined && attempt < 3; attempt++) {
      const meta = { id: `env.${key}`, key, optional: question.optional, ...(question.default === undefined ? {} : { default: question.default }) }
      const typed = await ctx.host.prompt(promptText(key, question), { secret: question.secret }, meta)
      if (typed === undefined) break
      const value = typed === '' && question.default !== undefined ? question.default : typed
      if (value === '' && !question.optional) { ctx.host.out.warn(`${key} is required`); continue }
      try {
        formatValue(value, key)
        answer = value
      } catch (error) {
        if (!(error instanceof UnwritableValueError)) throw error
        ctx.host.out.warn(error.message)
      }
    }
    if (answer === undefined) {
      if (!question.optional) { missing.push(key); continue }
      // A program's unanswered secret is never defaulted, not even to empty (RFC 0008 §7.3).
      if (question.secret && options.secretsNeverDefault) {
        ctx.host.out.warn(`${key} was not answered: left out of the .env`)
        continue
      }
      answer = question.default ?? ''
    }
    plan.changes.push({ kind: 'set', key, value: answer, reason: 'answered' })
  }
  plan.questions = []
  return missing
}

const promptText = (key: string, question: Question) => `${question.prompt} [${key}]${question.optional ? ' (empty to skip)' : ''}`

/** The questions for `keys`, as a program sees them (`plan --json`): never a value, never a secret's default. */
export function questionDescriptors(config: DeployConfig, keys: string[]): PromptDescriptor[] {
  return keys.flatMap((key) => {
    const question = config.env.ask?.[key as keyof typeof config.env.ask] as Question | undefined
    if (!question) return []
    return [{
      id: `env.${key}`, kind: question.secret ? 'secret' as const : 'text' as const, message: promptText(key, question), key, optional: question.optional,
      ...(!question.secret && question.default !== undefined ? { default: question.default } : {}),
    }]
  })
}

export function describeEnv(plan: EnvPlan): string[] {
  return [
    ...plan.changes.map((c) => c.kind === 'remove'
      ? `remove ${c.key} (${c.reason})`
      : `${plan.values.has(c.key) ? 'change' : 'add'} ${c.key} (${c.reason})`),
    ...plan.questions.map((key) => `ask ${key}`),
  ]
}

/** Backs the file up (0600, last 5 kept) and writes it atomically, 0600. */
export async function writeEnv(ctx: DeployContext, plan: EnvPlan): Promise<void> {
  if (plan.changes.length === 0) return
  const { host } = ctx
  const file = envFile(ctx)
  const text = applyEnvChanges(plan.document, plan.changes)
  if (await host.exists(file)) {
    const stamp = host.now().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
    await host.copyFile(file, `${file}.bak-${stamp}`, 0o600)
    const base = basename(file)
    const dir = dirname(file)
    const backups = (await host.list(dir)).filter((name) => name.startsWith(`${base}.bak-`)).sort()
    for (const old of backups.slice(0, -5)) await host.remove(join(dir, old))
  }
  await host.writeFile(file, text, 0o600)
  await writeMirrors(ctx, text)
  plan.document = parseEnv(text)
  plan.values = envValues(plan.document)
  plan.changes = []
}

/** Rewrites every mirror as an exact copy of the file (0600). */
export async function writeMirrors(ctx: DeployContext, text: string): Promise<void> {
  for (const mirror of envMirrors(ctx)) {
    if ((await ctx.host.readFile(mirror)) === text) continue
    await ctx.host.writeFile(mirror, text, 0o600)
  }
}

/**
 * The `.env` and its mirrors readable by anyone but their owner, or owned by
 * someone else than the deploy user: the secrets are exposed, or the deploy
 * cannot keep them 0600. `env` (and `run`) puts the mode right; an owner only
 * root can change.
 */
export async function envModeFindings(ctx: DeployContext): Promise<Finding[]> {
  const findings: Finding[] = []
  const me = ctx.host.uid()
  for (const file of [envFile(ctx), ...envMirrors(ctx)]) {
    const stat = await ctx.host.stat(file)
    if (stat?.kind !== 'file' || stat.mode === undefined) continue
    if (stat.uid !== undefined && stat.uid !== me) {
      findings.push({ id: 'env-owner', level: 'warning', message: `${file} is owned by uid ${stat.uid}, not by the deploy user (uid ${me})`, fix: `sudo chown "$USER": ${file} && chmod 600 ${file}` })
    } else if ((stat.mode & 0o077) !== 0) {
      findings.push({ id: 'env-mode', level: 'warning', message: `${file} is ${(stat.mode & 0o777).toString(8).padStart(3, '0')}: its secrets are readable by other users of this server`, fix: 'this deploy sets it to 0600 (env and run do)' })
    }
  }
  return findings
}

/** Puts the `.env` and its mirrors back to 0600 when the deploy user owns them. Returns the files changed. */
export async function secureEnvModes(ctx: DeployContext): Promise<string[]> {
  const fixed: string[] = []
  const me = ctx.host.uid()
  for (const file of [envFile(ctx), ...envMirrors(ctx)]) {
    const stat = await ctx.host.stat(file)
    if (stat?.kind !== 'file' || stat.mode === undefined || stat.uid !== me || (stat.mode & 0o077) === 0) continue
    await ctx.host.chmod(file, 0o600)
    fixed.push(file)
  }
  return fixed
}

/** C10 — a mirror that is not an exact copy: two env files that disagree are two configurations. */
export async function mirrorFindings(ctx: DeployContext): Promise<Finding[]> {
  const mirrors = envMirrors(ctx)
  if (mirrors.length === 0) return []
  const text = await ctx.host.readFile(envFile(ctx))
  const findings: Finding[] = []
  for (const mirror of mirrors) {
    const copy = await ctx.host.readFile(mirror)
    if (text === undefined || copy === text) continue
    findings.push({
      id: 'C10',
      level: 'error',
      message: copy === undefined ? `${mirror} (env.mirror) does not exist` : `${mirror} (env.mirror) differs from ${envFile(ctx)}`,
      fix: `cp -p ${envFile(ctx)} ${mirror} — after checking which one is right; the deploy rewrites the mirror from the file`,
    })
  }
  return findings
}

