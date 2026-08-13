import type { MakeResult } from '../make/types.js'
import type { ArchitecturePlan } from '../plan/types.js'
import type { AIProvider } from '../provider/types.js'
import { REVIEW_KNOWLEDGE } from './knowledge.js'
import type { AgentReview, ReviewIssue } from './types.js'

export interface ReviewOptions {
  temperature?: number
  maxTokens?: number
}

/** Files worth sending to the reviewer — the ones that carry the behaviour. */
const REVIEWABLE = /\.prisma$|\.(schema|routes|service|repository|permissions)\.ts$/

/**
 * Compact, relevant-only context for the Review agent: the request, the plan, the
 * deterministic review, and the generated code that carries behaviour.
 */
export function buildReviewContext(plan: ArchitecturePlan, result: MakeResult): string {
  const lines: string[] = [
    `REQUEST: ${plan.request}`,
    '',
    'PLAN:',
    `  summary: ${plan.summary}`,
    `  entities: ${plan.entities.map((e) => `${e.name}${e.tenantScoped ? ' (tenant-scoped)' : ''}`).join(', ')}`,
  ]
  if (plan.permissions.length > 0) lines.push(`  permissions: ${plan.permissions.join(', ')}`)
  if (plan.auditEvents.length > 0) lines.push(`  auditEvents: ${plan.auditEvents.join(', ')}`)

  lines.push('', 'DETERMINISTIC REVIEW:')
  for (const item of result.review.items) lines.push(`  [${item.status}] ${item.label}: ${item.detail}`)

  lines.push('', 'GENERATED CODE:')
  for (const resource of result.resources) {
    for (const file of resource.files) {
      if (REVIEWABLE.test(file.path)) lines.push(`--- ${file.path} ---`, file.content)
    }
  }
  return lines.join('\n')
}

/** Ask the Review agent to critique the generated code. Read-only — it judges, it doesn't edit. */
export async function reviewImplementation(
  provider: AIProvider,
  plan: ArchitecturePlan,
  result: MakeResult,
  options: ReviewOptions = {},
): Promise<AgentReview> {
  const raw = await provider.generate({
    messages: [
      { role: 'system', content: REVIEW_KNOWLEDGE },
      { role: 'user', content: `${buildReviewContext(plan, result)}\n\nReturn the verdict as a single JSON object.` },
    ],
    temperature: options.temperature ?? 0,
    maxTokens: options.maxTokens ?? 2048,
  })
  return parseReview(raw)
}

/** Parse the verdict. `approved` is derived from the issues, not trusted from the model. */
export function parseReview(raw: string): AgentReview {
  const json = extractJson(raw)
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error(`ai review — the model did not return valid JSON. Got: ${raw.slice(0, 160)}…`)
  }
  const issues = normalizeIssues(obj['issues'])
  return {
    approved: !issues.some((i) => i.severity === 'error'),
    summary: typeof obj['summary'] === 'string' ? obj['summary'] : '',
    issues,
  }
}

function normalizeIssues(value: unknown): ReviewIssue[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
    .map((i) => ({
      dimension: typeof i['dimension'] === 'string' ? i['dimension'] : 'general',
      severity: i['severity'] === 'error' ? ('error' as const) : ('warning' as const),
      message: typeof i['message'] === 'string' ? i['message'] : '',
    }))
    .filter((i) => i.message !== '')
}

function extractJson(raw: string): string {
  const withoutFence = raw.replace(/```(?:json)?/gi, '').trim()
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return withoutFence
  return withoutFence.slice(start, end + 1)
}
