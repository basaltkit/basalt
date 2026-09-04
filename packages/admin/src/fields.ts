import { z, type ZodTypeAny } from 'zod'

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'unknown'

/** A single form/column descriptor derived from a Zod schema. */
export interface Field {
  name: string
  label: string
  type: FieldType
  required: boolean
  /** Present for enum fields — the stored values, unchanged by any labelling. */
  options?: string[]
  /**
   * Display text per option value, present only when configured.
   *
   * Deliberately separate from `options` rather than replacing it with
   * value/label pairs: the values are what the form submits and the schema
   * validates, and a renderer that has never heard of this field keeps showing
   * exactly what it shows today. Read it through {@link optionLabel}.
   */
  optionLabels?: Record<string, string>
}

/** Per-field display configuration — see `ResourceConfig.fields`. */
export interface FieldConfig {
  /** Replaces the label derived from the field name. */
  label?: string
  /** Display text keyed by option value. Values left out keep the raw value. */
  options?: Record<string, string>
}

/** The label to show for one option value, falling back to the value itself. */
export function optionLabel(field: Field, value: string): string {
  return field.optionLabels?.[value] ?? value
}

/** 'createdAt' → 'Created At', 'blog_post' → 'Blog Post'. */
export function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

/** Peels optional/nullable/default wrappers to find the inner type and whether it is required. */
function unwrap(schema: ZodTypeAny): { inner: ZodTypeAny; required: boolean } {
  let current = schema
  let required = true
  for (let depth = 0; depth < 10; depth++) {
    if (current instanceof z.ZodOptional) {
      required = false
      current = current.unwrap() as ZodTypeAny
    } else if (current instanceof z.ZodNullable) {
      required = false
      current = current.unwrap() as ZodTypeAny
    } else if (current instanceof z.ZodDefault) {
      required = false
      current = current.removeDefault() as ZodTypeAny
    } else {
      break
    }
  }
  return { inner: current, required }
}

function classify(schema: ZodTypeAny): { type: FieldType; options?: string[] } {
  if (schema instanceof z.ZodString) return { type: 'string' }
  if (schema instanceof z.ZodNumber) return { type: 'number' }
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' }
  if (schema instanceof z.ZodDate) return { type: 'date' }
  if (schema instanceof z.ZodEnum) return { type: 'enum', options: schema.options as string[] }
  return { type: 'unknown' }
}

/**
 * Derives field descriptors from a Zod object schema — the heart of the admin kit.
 *
 * `overrides` is keyed by field name and applied to whichever schema is being
 * described, so one map covers the table, the create form and the edit form. A
 * key naming no field is ignored: a rename leaves a stale entry behind, and
 * refusing to describe the resource over a leftover translation would be a poor
 * trade.
 */
export function fieldsFromSchema(
  schema: z.ZodObject<z.ZodRawShape>,
  overrides: Record<string, FieldConfig> = {},
): Field[] {
  return Object.entries(schema.shape).map(([name, def]) => {
    const { inner, required } = unwrap(def as ZodTypeAny)
    const { type, options } = classify(inner)
    const config = overrides[name]
    // Only labels for values this field actually has: a leftover entry for a
    // removed enum member would otherwise travel to the browser as a choice.
    const labels = Object.fromEntries(
      Object.entries(config?.options ?? {}).filter(([value]) => options?.includes(value)),
    )
    return {
      name,
      label: config?.label ?? humanize(name),
      type,
      required,
      ...(options ? { options } : {}),
      ...(Object.keys(labels).length > 0 ? { optionLabels: labels } : {}),
    }
  })
}
