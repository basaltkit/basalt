import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  defineResource,
  fieldsFromSchema,
  formView,
  humanize,
  memoryDataSource,
  tableView,
} from '../src/index.js'

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['draft', 'published']),
  priority: z.number().default(0),
  archived: z.boolean().optional(),
  dueAt: z.date().nullable(),
})

const CreateProjectSchema = z.object({
  name: z.string().min(3),
  status: z.enum(['draft', 'published']),
})

describe('fieldsFromSchema', () => {
  it('classifies types and requiredness, unwrapping optional/nullable/default', () => {
    const fields = fieldsFromSchema(ProjectSchema)
    expect(fields).toEqual([
      { name: 'id', label: 'Id', type: 'string', required: true },
      { name: 'name', label: 'Name', type: 'string', required: true },
      { name: 'status', label: 'Status', type: 'enum', required: true, options: ['draft', 'published'] },
      { name: 'priority', label: 'Priority', type: 'number', required: false },
      { name: 'archived', label: 'Archived', type: 'boolean', required: false },
      { name: 'dueAt', label: 'Due At', type: 'date', required: false },
    ])
  })

  it('humanize handles camelCase, snake_case and kebab-case', () => {
    expect(humanize('createdAt')).toBe('Created At')
    expect(humanize('blog_post_title')).toBe('Blog Post Title')
    expect(humanize('due-date')).toBe('Due Date')
  })
})

describe('Resource', () => {
  const resource = defineResource({
    name: 'projects',
    schema: ProjectSchema,
    createSchema: CreateProjectSchema,
    columns: ['name', 'status'],
  })

  it('derives label, columns (ordered subset) and form fields', () => {
    expect(resource.label).toBe('Projects')
    expect(resource.columns().map((column) => column.name)).toEqual(['name', 'status'])
    expect(resource.formFields().map((field) => field.name)).toEqual(['name', 'status'])
  })

  it('form fields fall back to entity fields minus the id when no create schema', () => {
    const bare = defineResource({ name: 'tags', schema: z.object({ id: z.string(), label: z.string() }) })
    expect(bare.formFields().map((field) => field.name)).toEqual(['label'])
  })

  it('validates input, mapping errors to field names', () => {
    expect(resource.validate({ name: 'Basalt', status: 'draft' })).toMatchObject({ success: true })
    const failed = resource.validate({ name: 'ab', status: 'nope' })
    expect(failed.success).toBe(false)
    expect(failed.errors).toHaveProperty('name')
    expect(failed.errors).toHaveProperty('status')
  })

  it('builds table and form view models', () => {
    const table = tableView(resource, [{ id: 'p1', name: 'A', status: 'draft' }])
    expect(table.columns.map((c) => c.name)).toEqual(['name', 'status'])
    expect(table.rows).toHaveLength(1)

    const form = formView(resource, { name: 'A' }, 'create')
    expect(form.fields.map((f) => f.name)).toEqual(['name', 'status'])
    expect(form.values).toEqual({ name: 'A' })
    expect(form.mode).toBe('create')
  })
})

describe('memoryDataSource', () => {
  it('does CRUD and free-text search', async () => {
    const source = memoryDataSource<{ id: string; name: string }>([
      { id: 'p1', name: 'Apollo' },
      { id: 'p2', name: 'Zephyr' },
    ])

    expect(await source.list()).toHaveLength(2)
    expect((await source.list({ search: 'apo' })).map((row) => row.id)).toEqual(['p1'])

    const created = await source.create({ name: 'Nova' })
    expect(created.id).toBeTruthy()
    expect(await source.get(created.id)).toEqual(created)

    const updated = await source.update('p1', { name: 'Apollo 2' })
    expect(updated?.name).toBe('Apollo 2')
    expect(await source.update('missing', { name: 'x' })).toBeNull()

    expect(await source.remove('p2')).toBe(true)
    expect(await source.remove('p2')).toBe(false)
    expect(await source.list()).toHaveLength(2)
  })

  it('paginates', async () => {
    const source = memoryDataSource(
      Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, name: `Item ${i}` })),
    )
    expect(await source.list({ page: 1, pageSize: 3 })).toHaveLength(3)
    expect(await source.list({ page: 4, pageSize: 3 })).toHaveLength(1)
  })
})
