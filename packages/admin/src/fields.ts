import { z, type ZodTypeAny } from 'zod'

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'enum' | 'unknown'

/** A single form/column descriptor derived from a Zod schema. */
export interface Field {
  name: string
  label: string
  type: FieldType
  required: boolean
  /** Present for enum fields. */
  options?: string[]
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

/** Derives field descriptors from a Zod object schema — the heart of the admin kit. */
export function fieldsFromSchema(schema: z.ZodObject<z.ZodRawShape>): Field[] {
  return Object.entries(schema.shape).map(([name, def]) => {
    const { inner, required } = unwrap(def as ZodTypeAny)
    const { type, options } = classify(inner)
    return { name, label: humanize(name), type, required, ...(options ? { options } : {}) }
  })
}
