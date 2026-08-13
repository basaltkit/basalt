import type { PlanField } from '../plan/types.js'

export type CanonicalType = 'String' | 'Int' | 'Float' | 'Boolean' | 'DateTime' | 'Json'

/** Columns the generator already emits — never re-inject these. */
const RESERVED = new Set(['id', 'name', 'createdat', 'updatedat', 'deletedat', 'tenantid'])

/** Map a loose plan type (`'string'`, `'DateTime'`, `'number'`…) to a canonical type. */
export function canonicalType(raw: string): CanonicalType {
  switch (raw.trim().toLowerCase()) {
    case 'int':
    case 'integer':
    case 'number':
    case 'bigint':
      return 'Int'
    case 'float':
    case 'decimal':
    case 'double':
      return 'Float'
    case 'bool':
    case 'boolean':
      return 'Boolean'
    case 'date':
    case 'datetime':
    case 'timestamp':
      return 'DateTime'
    case 'json':
    case 'object':
      return 'Json'
    default:
      return 'String'
  }
}

/** Prisma column type — identical to the canonical name. */
export function prismaType(t: CanonicalType): string {
  return t
}

/** Zod validator for a field. Dates are strings, matching the generator's convention. */
export function zodValidator(t: CanonicalType, create: boolean): string {
  switch (t) {
    case 'Int':
      return 'z.number().int()'
    case 'Float':
      return 'z.number()'
    case 'Boolean':
      return 'z.boolean()'
    case 'DateTime':
      return 'z.string()'
    case 'Json':
      return 'z.unknown()'
    case 'String':
      return create ? 'z.string().min(1)' : 'z.string()'
  }
}

function usable(field: PlanField): boolean {
  return field.name.trim() !== '' && !RESERVED.has(field.name.toLowerCase())
}

/** The entity's own fields, minus reserved/base columns and duplicates. */
export function domainFields(fields: PlanField[]): PlanField[] {
  const seen = new Set<string>()
  const out: PlanField[] = []
  for (const field of fields) {
    const key = field.name.toLowerCase()
    if (!usable(field) || seen.has(key)) continue
    seen.add(key)
    out.push(field)
  }
  return out
}

function hasPrismaField(content: string, name: string): boolean {
  return new RegExp(`^[ \\t]*${name}[ \\t]+`, 'm').test(content)
}

/**
 * Inject domain fields (and `tenantId` + `@@index` when tenant-scoped) into a
 * generated Prisma model snippet, right after its `name` column. Returns
 * `injected: false` if the expected anchor isn't found — the scaffold still lands
 * unchanged and the caller reports it.
 */
export function injectPrismaFields(
  content: string,
  fields: PlanField[],
  tenantScoped: boolean,
  removeName = false,
): { content: string; injected: boolean } {
  const nameAnchor = /^([ \t]*)name[ \t]+String.*$/m
  if (!nameAnchor.test(content)) return { content, injected: false }

  const extras: string[] = []
  if (tenantScoped && !hasPrismaField(content, 'tenantId')) extras.push('  tenantId  String')
  for (const field of fields) {
    if (!usable(field) || hasPrismaField(content, field.name)) continue
    extras.push(`  ${field.name}  ${prismaType(canonicalType(field.type))}`)
  }
  if (extras.length === 0) return { content, injected: false }

  let out = content.replace(nameAnchor, (line) => `${line}\n${extras.join('\n')}`)
  if (tenantScoped) out = out.replace(/\n\}\s*$/, `\n\n  @@index([tenantId])\n}\n`)
  // Drop the generator's base `name` column when the entity supplies its own
  // fields and none is literally `name` (avoids a spurious empty column).
  if (removeName) out = out.replace(/^[ \t]*name[ \t]+String\b.*\n/m, '')
  return { content: out, injected: true }
}

/**
 * Inject domain fields into a generated Zod schema file — into both the entity
 * schema (`<Name>Schema`) and the create schema (`Create<Name>Schema`).
 */
export function injectZodFields(
  content: string,
  fields: PlanField[],
  removeName = false,
): { content: string; injected: boolean } {
  const usableFields = domainFields(fields)
  if (usableFields.length === 0) return { content, injected: false }

  let out = content
  let injected = false

  const entityAnchor = /^([ \t]*)name: z\.string\(\),.*$/m
  const entityLines = usableFields.map((f) => `  ${f.name}: ${zodValidator(canonicalType(f.type), false)},`)
  if (entityAnchor.test(out)) {
    out = out.replace(entityAnchor, (line) => `${line}\n${entityLines.join('\n')}`)
    injected = true
  }

  const createAnchor = /^([ \t]*)name: z\.string\(\)\.min\(1\),.*$/m
  const createLines = usableFields.map((f) => `  ${f.name}: ${zodValidator(canonicalType(f.type), true)},`)
  if (createAnchor.test(out)) {
    out = out.replace(createAnchor, (line) => `${line}\n${createLines.join('\n')}`)
    injected = true
  }

  // Drop the base `name` from both schemas when the entity has its own fields
  // and none is literally `name`.
  if (removeName) {
    out = out.replace(/^[ \t]*name: z\.string\(\),.*\n/m, '')
    out = out.replace(/^[ \t]*name: z\.string\(\)\.min\(1\),.*\n/m, '')
  }

  return { content: out, injected }
}
