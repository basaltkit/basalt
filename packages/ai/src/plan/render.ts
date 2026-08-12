import type { LineWriter } from '../render.js'
import type { ArchitecturePlan } from './types.js'

/** Render an {@link ArchitecturePlan} in the spec's `ARCHITECTURE PLAN` style. */
export function renderPlan(plan: ArchitecturePlan, io: LineWriter): void {
  io.log('ARCHITECTURE PLAN')
  io.log('')
  io.log(`Request: "${plan.request}"`)
  if (plan.summary) {
    io.log('')
    io.log(plan.summary)
  }

  if (plan.entities.length > 0) {
    io.log('')
    io.log('Entities:')
    for (const entity of plan.entities) {
      const scope = entity.tenantScoped ? ' (tenant-scoped)' : ''
      const fields = entity.fields.map((f) => `${f.name}: ${f.type}`).join(', ')
      io.log(`  • ${entity.name}${scope}${fields ? ` — ${fields}` : ''}`)
      if (entity.relations && entity.relations.length > 0) {
        io.log(`      relations: ${entity.relations.join(', ')}`)
      }
    }
  }

  io.log('')
  io.log('Steps:')
  if (plan.steps.length === 0) {
    io.log('  (none proposed)')
  } else {
    for (const step of plan.steps) {
      const n = String(step.order).padStart(2, ' ')
      io.log(`  ${n}. [${step.kind}] ${step.title}`)
      if (step.detail) io.log(`        ${step.detail}`)
      if (step.command) io.log(`        $ ${step.command}`)
      if (step.files && step.files.length > 0) io.log(`        files: ${step.files.join(', ')}`)
    }
  }

  if (plan.permissions.length > 0) {
    io.log('')
    io.log(`Permissions: ${plan.permissions.join(', ')}`)
  }
  if (plan.auditEvents.length > 0) {
    io.log(`Audit events: ${plan.auditEvents.join(', ')}`)
  }

  if (plan.warnings.length > 0) {
    io.log('')
    io.log('⚠ Warnings:')
    for (const warning of plan.warnings) io.log(`  - ${warning}`)
  }

  io.log('')
  io.log('This is a plan only — nothing was changed.')
  io.log('Next: `basalt ai:make` will execute it (arrives in the next phase).')
}
