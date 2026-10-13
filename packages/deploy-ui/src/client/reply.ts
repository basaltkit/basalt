import type { ErrorEvent } from '@basaltkit/deploy/protocol'
import { el, type Child } from './dom.js'
import type { CommandReply, Failure } from './messages.js'
import { ApiError } from './api.js'

/** What went wrong, as a banner: a protocol error (code, message, hint), a failure of the connection, or the local server's refusal. */
export function problem(reply: CommandReply | undefined, error?: unknown): HTMLElement | null {
  if (error !== undefined) return banner('err', 'The UI refused the request', [describe(error)])
  if (!reply) return null
  if (reply.failure) return failureBanner(reply.failure, reply.diagnostics)
  if (reply.error) return errorBanner(reply.error, reply.diagnostics)
  if (!reply.ok) return banner('err', 'The command failed', [`exit code ${reply.exitCode ?? 'unknown'}`], reply.diagnostics)
  return null
}

export function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (HTTP ${error.status})`
  return error instanceof Error ? error.message : String(error)
}

export function failureBanner(failure: Failure, diagnostics: string[] = []): HTMLElement {
  return banner('err', failure.message, failure.hint ? [failure.hint] : [], diagnostics, failure.code)
}

export function errorBanner(error: ErrorEvent, diagnostics: string[] = []): HTMLElement {
  const lines: Child[] = []
  if (error.hint) lines.push(error.hint)
  if (error.holder) lines.push(`held by pid ${error.holder.pid} on ${error.holder.host}, ${error.holder.actor}, ${error.holder.command}${error.holder.runId ? ` (run ${error.holder.runId})` : ''}`)
  for (const finding of error.findings ?? []) lines.push(`${finding.level}: ${finding.message}${finding.fix ? ` — ${finding.fix}` : ''}`)
  return banner('err', error.message, lines, diagnostics, error.code)
}

export function banner(level: 'ok' | 'warn' | 'err', title: string, lines: Child[] = [], diagnostics: string[] = [], code?: string): HTMLElement {
  return el('div', { class: `banner ${level}`, role: level === 'err' ? 'alert' : 'status' },
    el('strong', {}, level === 'ok' ? 'OK: ' : level === 'warn' ? 'Warning: ' : 'Error: ', title),
    code ? el('span', { class: 'muted' }, ` [${code}]`) : null,
    ...lines.map((line) => el('p', {}, line)),
    diagnostics.length > 0 ? diagnosticsBlock(diagnostics) : null,
  )
}

export function diagnosticsBlock(lines: string[]): HTMLElement {
  return el('details', {}, el('summary', {}, `Diagnostics (${lines.length})`), el('pre', { class: 'diagnostics' }, lines.join('\n')))
}
