import { names } from '@basaltkit/generator'
import type { PlanEntity, PlanField, PlanRelation } from '../plan/types.js'

/**
 * Real Prisma relations (Fase 6). A belongs-to relation on an entity generates:
 * a `<name>Id` FK column, a `<name> <Model> @relation(...)` field, and — on the
 * related model — an inverse `<plural> <This>[]` field. Both sides are required
 * for Prisma to validate, so a relation to a model outside the plan is surfaced
 * as a follow-up (the user adds the inverse field to their existing model).
 */

/** FK column name for a relation, e.g. `paciente` → `pacienteId`. */
export function foreignKey(relation: PlanRelation): string {
  return `${relation.name}Id`
}

/** Synthetic FK fields (String) for an entity's relations — feed the Zod schema, mapper and columns. */
export function relationForeignKeys(entity: PlanEntity): PlanField[] {
  return (entity.relations ?? []).map((r) => ({ name: foreignKey(r), type: 'String' }))
}

/** Prisma relation field lines for the entity's belongs-to relations. */
export function relationFieldLines(entity: PlanEntity): string[] {
  return (entity.relations ?? []).map(
    (r) => `  ${r.name} ${names(r.model).pascal} @relation(fields: [${foreignKey(r)}], references: [id])`,
  )
}

/** Inverse `hasMany` lines to add to `modelName`, from every other entity that belongs to it. */
export function inverseRelationLines(modelName: string, allEntities: PlanEntity[]): string[] {
  const target = names(modelName).pascal
  const lines: string[] = []
  for (const other of allEntities) {
    if (names(other.name).pascal === target) continue
    for (const r of other.relations ?? []) {
      if (names(r.model).pascal === target) {
        lines.push(`  ${pluralCamel(other.name)} ${names(other.name).pascal}[]`)
      }
    }
  }
  return lines
}

/** Insert relation + inverse lines into a generated Prisma model, before its closing brace. */
export function injectPrismaRelations(
  content: string,
  relationLines: string[],
  inverseLines: string[],
): { content: string; injected: boolean } {
  const all = [...relationLines, ...inverseLines]
  if (all.length === 0) return { content, injected: false }
  const out = content.replace(/\n\}\s*$/, `\n${all.join('\n')}\n}\n`)
  return { content: out, injected: out !== content }
}

/** Relation targets that aren't generated in this plan (need a manual inverse field). */
export function externalRelationTargets(entities: PlanEntity[]): string[] {
  const planModels = new Set(entities.map((e) => names(e.name).pascal))
  const external = new Set<string>()
  for (const e of entities) {
    for (const r of e.relations ?? []) {
      const target = names(r.model).pascal
      if (!planModels.has(target)) external.add(target)
    }
  }
  return [...external]
}

function pluralCamel(name: string): string {
  return names(name)
    .pluralKebab.split('-')
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('')
}
