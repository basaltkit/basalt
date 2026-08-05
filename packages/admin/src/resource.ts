import type { z } from 'zod'
import { fieldsFromSchema, humanize, type Field } from './fields.js'

export interface ResourceConfig {
  /** Plural machine name, e.g. 'projects'. */
  name: string
  label?: string
  /** Entity schema — drives table columns. */
  schema: z.ZodObject<z.ZodRawShape>
  /** Input schema for creation — drives the create form and validation. */
  createSchema?: z.ZodObject<z.ZodRawShape>
  /** Input schema for edits. Defaults to createSchema. */
  updateSchema?: z.ZodObject<z.ZodRawShape>
  /** Ordered subset of fields shown in the table. Defaults to all. */
  columns?: string[]
  /** Identifier field. Default: 'id'. */
  idField?: string
}

export type FormMode = 'create' | 'update'

export interface ValidationResult {
  success: boolean
  data?: unknown
  /** One message per field, keyed by field name. */
  errors?: Record<string, string>
}

export class Resource {
  readonly name: string
  readonly label: string
  readonly idField: string

  constructor(private readonly config: ResourceConfig) {
    this.name = config.name
    this.label = config.label ?? humanize(config.name)
    this.idField = config.idField ?? 'id'
  }

  /** All entity fields. */
  fields(): Field[] {
    return fieldsFromSchema(this.config.schema)
  }

  /** Table columns, honoring the configured order/subset. */
  columns(): Field[] {
    const all = this.fields()
    if (!this.config.columns) return all
    return this.config.columns
      .map((name) => all.find((field) => field.name === name))
      .filter((field): field is Field => field !== undefined)
  }

  /** Form fields for the given mode (falls back to entity fields minus the id). */
  formFields(mode: FormMode = 'create'): Field[] {
    const schema = this.schemaFor(mode)
    return schema ? fieldsFromSchema(schema) : this.fields().filter((f) => f.name !== this.idField)
  }

  /** Validates input against the mode's schema, mapping errors to field names. */
  validate(input: unknown, mode: FormMode = 'create'): ValidationResult {
    const schema = this.schemaFor(mode)
    if (!schema) return { success: true, data: input }
    const result = schema.safeParse(input)
    if (result.success) return { success: true, data: result.data }

    const errors: Record<string, string> = {}
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? '_')
      if (!(key in errors)) errors[key] = issue.message
    }
    return { success: false, errors }
  }

  private schemaFor(mode: FormMode): z.ZodObject<z.ZodRawShape> | undefined {
    if (mode === 'update') return this.config.updateSchema ?? this.config.createSchema
    return this.config.createSchema
  }
}

export function defineResource(config: ResourceConfig): Resource {
  return new Resource(config)
}

// --- view models (headless — the React layer renders these) --------------

export interface TableView {
  columns: Field[]
  rows: Record<string, unknown>[]
}

export function tableView(resource: Resource, rows: Record<string, unknown>[]): TableView {
  return { columns: resource.columns(), rows }
}

export interface FormView {
  fields: Field[]
  values: Record<string, unknown>
  mode: FormMode
}

export function formView(
  resource: Resource,
  values: Record<string, unknown> = {},
  mode: FormMode = 'create',
): FormView {
  return { fields: resource.formFields(mode), values, mode }
}
