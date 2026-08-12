import type { ProjectContext } from '../context/project.js'
import type { AIProvider } from '../provider/types.js'
import { buildPlanContext } from './context.js'
import { BASALT_KNOWLEDGE } from './knowledge.js'
import type { ArchitecturePlan, PlanEntity, PlanStep, PlanStepKind } from './types.js'

export interface CreatePlanOptions {
  temperature?: number
  maxTokens?: number
}

const STEP_KINDS: PlanStepKind[] = [
  'generator',
  'schema',
  'migration',
  'service',
  'routes',
  'permissions',
  'audit',
  'test',
  'docs',
  'other',
]

/**
 * Turn a natural-language request into a grounded {@link ArchitecturePlan}. The
 * project context keeps the plan on-convention and collision-free. Read-only —
 * it produces a plan, it changes nothing.
 */
export async function createPlan(
  provider: AIProvider,
  ctx: ProjectContext,
  request: string,
  options: CreatePlanOptions = {},
): Promise<ArchitecturePlan> {
  const raw = await provider.generate({
    messages: [
      { role: 'system', content: BASALT_KNOWLEDGE },
      {
        role: 'user',
        content: `REQUEST:\n${request}\n\n${buildPlanContext(ctx)}\n\nReturn the plan as a single JSON object only.`,
      },
    ],
    temperature: options.temperature ?? 0,
    maxTokens: options.maxTokens ?? 4096,
  })
  return parsePlan(raw, request)
}

/** Parse + normalize the model's JSON into a validated plan. Tolerant of fences and missing arrays. */
export function parsePlan(raw: string, request: string): ArchitecturePlan {
  const json = extractJson(raw)
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error(`ai:plan — the model did not return valid JSON. Got: ${raw.slice(0, 160)}…`)
  }

  return {
    request,
    summary: typeof obj['summary'] === 'string' ? obj['summary'] : '',
    entities: normalizeEntities(obj['entities']),
    steps: normalizeSteps(obj['steps']),
    permissions: stringArray(obj['permissions']),
    auditEvents: stringArray(obj['auditEvents']),
    tenantScoped: obj['tenantScoped'] === true,
    warnings: stringArray(obj['warnings']),
  }
}

/** Strip markdown fences and isolate the outermost JSON object. */
function extractJson(raw: string): string {
  const withoutFence = raw.replace(/```(?:json)?/gi, '').trim()
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return withoutFence
  return withoutFence.slice(start, end + 1)
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function normalizeEntities(value: unknown): PlanEntity[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => {
      const relations = stringArray(e['relations'])
      const entity: PlanEntity = {
        name: typeof e['name'] === 'string' ? e['name'] : 'Unnamed',
        fields: normalizeFields(e['fields']),
        tenantScoped: e['tenantScoped'] === true,
        ...(relations.length > 0 ? { relations } : {}),
      }
      return entity
    })
}

function normalizeFields(value: unknown): PlanEntity['fields'] {
  if (!Array.isArray(value)) return []
  return value
    .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
    .map((f) => ({
      name: typeof f['name'] === 'string' ? f['name'] : '',
      type: typeof f['type'] === 'string' ? f['type'] : 'String',
    }))
    .filter((f) => f.name !== '')
}

function normalizeSteps(value: unknown): PlanStep[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
    .map((s, index) => {
      const command = typeof s['command'] === 'string' ? s['command'] : undefined
      const files = stringArray(s['files'])
      const step: PlanStep = {
        order: typeof s['order'] === 'number' ? s['order'] : index + 1,
        title: typeof s['title'] === 'string' ? s['title'] : `Step ${index + 1}`,
        kind: normalizeKind(s['kind']),
        detail: typeof s['detail'] === 'string' ? s['detail'] : '',
        ...(command ? { command } : {}),
        ...(files.length > 0 ? { files } : {}),
      }
      return step
    })
    .sort((a, b) => a.order - b.order)
}

function normalizeKind(value: unknown): PlanStepKind {
  return typeof value === 'string' && (STEP_KINDS as string[]).includes(value)
    ? (value as PlanStepKind)
    : 'other'
}
