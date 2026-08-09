import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { z } from 'zod'
import { defineResource, memoryDataSource } from '@basaltkit/admin'
import { DataTable, ResourceForm, useList } from '../src/index.js'

afterEach(cleanup)

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['draft', 'published']),
  archived: z.boolean(),
})

const CreateProjectSchema = z.object({
  name: z.string().min(3),
  status: z.enum(['draft', 'published']),
  archived: z.boolean().optional(),
})

const resource = defineResource({
  name: 'projects',
  schema: ProjectSchema,
  createSchema: CreateProjectSchema,
  columns: ['name', 'status', 'archived'],
})

describe('DataTable', () => {
  it('renders headers and formatted cells from the schema', () => {
    render(
      <DataTable
        resource={resource}
        rows={[{ id: 'p1', name: 'Apollo', status: 'draft', archived: true }]}
      />,
    )
    expect(screen.getByText('Name')).toBeDefined()
    expect(screen.getByText('Status')).toBeDefined()
    expect(screen.getByText('Apollo')).toBeDefined()
    // boolean rendered as Yes/No
    expect(screen.getByText('Yes')).toBeDefined()
  })

  it('shows the empty state and handles row clicks', () => {
    const onRowClick = vi.fn()
    const { rerender } = render(<DataTable resource={resource} rows={[]} emptyLabel="Nothing here" />)
    expect(screen.getByText('Nothing here')).toBeDefined()

    rerender(
      <DataTable
        resource={resource}
        rows={[{ id: 'p1', name: 'Apollo', status: 'draft', archived: false }]}
        onRowClick={onRowClick}
      />,
    )
    fireEvent.click(screen.getByText('Apollo'))
    expect(onRowClick).toHaveBeenCalledWith({ id: 'p1', name: 'Apollo', status: 'draft', archived: false })
  })
})

describe('ResourceForm', () => {
  it('renders fields from the create schema and submits parsed data', async () => {
    const onSubmit = vi.fn()
    render(<ResourceForm resource={resource} onSubmit={onSubmit} />)

    // enum → <select>, string → text input
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Basalt' } })
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'published' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Basalt', status: 'published' })
  })

  it('shows per-field validation errors and blocks submit', async () => {
    const onSubmit = vi.fn()
    render(<ResourceForm resource={resource} onSubmit={onSubmit} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ab' } }) // min(3)
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'published' } })
    fireEvent.click(screen.getByText('Save'))

    const alert = await screen.findByRole('alert')
    expect(alert.getAttribute('data-field')).toBe('name')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('edits with initial values (update mode)', async () => {
    const onSubmit = vi.fn()
    render(
      <ResourceForm
        resource={resource}
        mode="update"
        initialValues={{ name: 'Existing', status: 'draft' }}
        onSubmit={onSubmit}
      />,
    )
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement
    expect(nameInput.value).toBe('Existing')
    fireEvent.change(nameInput, { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: 'Renamed', status: 'draft' }))
  })
})

describe('useList', () => {
  it('loads data from a source on mount and reloads', async () => {
    const source = memoryDataSource<{ id: string; name: string }>([
      { id: 'p1', name: 'Apollo' },
      { id: 'p2', name: 'Zephyr' },
    ])
    const { result } = renderHook(() => useList(source))

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.data).toHaveLength(2)
    expect(result.current.error).toBeNull()

    await source.create({ name: 'Nova' })
    await result.current.reload()
    await waitFor(() => expect(result.current.data).toHaveLength(3))
  })

  it('captures errors from the source', async () => {
    const failing = {
      list: async () => {
        throw new Error('boom')
      },
    } as unknown as Parameters<typeof useList>[0]
    const { result } = renderHook(() => useList(failing))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect((result.current.error as Error).message).toBe('boom')
  })
})
