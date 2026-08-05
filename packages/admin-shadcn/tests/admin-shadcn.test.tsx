import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { z } from 'zod'
import { defineResource } from '@machize/admin'
import { Badge, Button, DataTable, ResourceForm, buttonVariants, cn } from '../src/index.js'

afterEach(cleanup)

describe('cn', () => {
  it('merges classes and resolves Tailwind conflicts (last wins)', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
    expect(cn('text-sm', false && 'hidden', 'font-medium')).toBe('text-sm font-medium')
  })
})

describe('Button', () => {
  it('applies variant + size classes from cva', () => {
    render(
      <Button variant="destructive" size="sm">
        Delete
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Delete' })
    expect(button.className).toContain('bg-destructive')
    expect(button.className).toContain('h-8') // size sm
    expect(buttonVariants({ variant: 'outline' })).toContain('border-input')
  })

  it('asChild renders as the child element (Radix Slot), keeping the classes', () => {
    render(
      <Button asChild variant="link">
        <a href="/x">Link</a>
      </Button>,
    )
    const link = screen.getByRole('link', { name: 'Link' })
    expect(link.tagName).toBe('A')
    expect(link.className).toContain('underline-offset-4') // link variant
  })

  it('forwards clicks', () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Go</Button>)
    fireEvent.click(screen.getByText('Go'))
    expect(onClick).toHaveBeenCalledOnce()
  })
})

describe('Badge', () => {
  it('renders the variant class', () => {
    render(<Badge variant="secondary">New</Badge>)
    expect(screen.getByText('New').className).toContain('bg-secondary')
  })
})

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['draft', 'published']),
  archived: z.boolean(),
})
const CreateProjectSchema = z.object({
  name: z.string().min(3),
  status: z.enum(['draft', 'published']),
})
const resource = defineResource({
  name: 'projects',
  schema: ProjectSchema,
  createSchema: CreateProjectSchema,
  columns: ['name', 'status', 'archived'],
})

describe('DataTable', () => {
  it('renders a shadcn table with headers and boolean badges', () => {
    render(
      <DataTable resource={resource} rows={[{ id: 'p1', name: 'Apollo', status: 'draft', archived: true }]} />,
    )
    expect(screen.getByRole('table')).toBeDefined()
    expect(screen.getByText('Name')).toBeDefined()
    expect(screen.getByText('Apollo')).toBeDefined()
    // boolean cell rendered as a Badge
    const badge = screen.getByText('Yes')
    expect(badge.className).toContain('inline-flex')
  })

  it('empty state and row click', () => {
    const onRowClick = vi.fn()
    const { rerender } = render(<DataTable resource={resource} rows={[]} emptyLabel="Nothing" />)
    expect(screen.getByText('Nothing')).toBeDefined()

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
  it('renders shadcn inputs and submits parsed data', async () => {
    const onSubmit = vi.fn()
    render(<ResourceForm resource={resource} onSubmit={onSubmit} />)

    const name = screen.getByLabelText('Name')
    expect(name.className).toContain('rounded-md') // shadcn Input styling
    fireEvent.change(name, { target: { value: 'Machize' } })
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'published' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ name: 'Machize', status: 'published' }))
  })

  it('shows a destructive validation message and blocks submit', async () => {
    const onSubmit = vi.fn()
    render(<ResourceForm resource={resource} onSubmit={onSubmit} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ab' } })
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const alert = await screen.findByRole('alert')
    expect(alert.getAttribute('data-field')).toBe('name')
    expect(alert.className).toContain('text-destructive')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
