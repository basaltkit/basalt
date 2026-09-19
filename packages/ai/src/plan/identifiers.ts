import type { ArchitecturePlan } from './types.js'

/**
 * A plan is untrusted input — an LLM output, or a plan object an MCP client
 * hands to `basalt_make`. Every name in it is interpolated into generated
 * TypeScript/Prisma source, so names are restricted to shapes that can never
 * break out of their syntactic position (identifier, string literal).
 */

/** Field and relation names — emitted verbatim as TS properties and Prisma columns. */
export const PLAN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Entity / related-model names — normalized by the generator's `names()` (words → PascalCase). */
export const PLAN_ENTITY_NAME = /^[A-Za-z][A-Za-z0-9 _-]{0,99}$/

/** Audit event names (`invoice.created`, `billing:paid`) — emitted inside string literals. */
export const PLAN_EVENT_NAME = /^[A-Za-z0-9_]+(?:[.:-][A-Za-z0-9_]+)*$/

export class UnsafePlanError extends Error {
  constructor(message: string) {
    super(`ai:make — unsafe plan: ${message}`)
    this.name = 'UnsafePlanError'
  }
}

/**
 * Throws {@link UnsafePlanError} if any name in the plan could inject code into
 * the generated sources. Enum VALUES are free text: they are always emitted as
 * escaped string literals (see `tsStringLiteral`), never raw.
 */
export function assertSafePlan(plan: ArchitecturePlan): void {
  const entities: unknown = plan.entities
  if (!Array.isArray(entities)) throw new UnsafePlanError('`entities` must be an array.')
  for (const entity of plan.entities) {
    if (typeof entity.name !== 'string' || !PLAN_ENTITY_NAME.test(entity.name)) {
      throw new UnsafePlanError(`entity name ${JSON.stringify(entity.name)} is not a valid identifier.`)
    }
    for (const field of entity.fields ?? []) {
      if (typeof field.name !== 'string' || !PLAN_IDENTIFIER.test(field.name)) {
        throw new UnsafePlanError(`field name ${JSON.stringify(field.name)} on ${entity.name} is not a valid identifier.`)
      }
      if (field.enum !== undefined && !(Array.isArray(field.enum) && field.enum.every((v) => typeof v === 'string'))) {
        throw new UnsafePlanError(`enum of ${entity.name}.${field.name} must be an array of strings.`)
      }
    }
    for (const relation of entity.relations ?? []) {
      if (typeof relation.name !== 'string' || !PLAN_IDENTIFIER.test(relation.name)) {
        throw new UnsafePlanError(`relation name ${JSON.stringify(relation.name)} on ${entity.name} is not a valid identifier.`)
      }
      if (typeof relation.model !== 'string' || !PLAN_ENTITY_NAME.test(relation.model)) {
        throw new UnsafePlanError(`relation model ${JSON.stringify(relation.model)} on ${entity.name} is not a valid identifier.`)
      }
    }
  }
  for (const event of plan.auditEvents ?? []) {
    if (typeof event !== 'string' || !PLAN_EVENT_NAME.test(event)) {
      throw new UnsafePlanError(`audit event ${JSON.stringify(event)} is not a valid event name.`)
    }
  }
}
