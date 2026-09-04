import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { z } from 'zod'
import { defineResource } from '@basaltkit/admin'
import { DataTable, ResourceForm } from '../src/index.js'

afterEach(cleanup)

/**
 * B14 · the configured labels have to reach the rendered output.
 *
 * The descriptor carrying `optionLabels` is only half the fix: a renderer that
 * keeps printing the option value leaves the form exactly as it was.
 */

const ContactSchema = z.object({
  id: z.string(),
  taxId: z.string(),
  kind: z.enum(['person', 'company']),
})

const contacts = defineResource({
  name: 'contacts',
  schema: ContactSchema,
  createSchema: z.object({ taxId: z.string(), kind: z.enum(['person', 'company']) }),
  columns: ['taxId', 'kind'],
  fields: {
    taxId: { label: 'NIF' },
    kind: { label: 'Tipo', options: { person: 'Pessoa', company: 'Empresa' } },
  },
})

describe('translated resource', () => {
  it('labels the column header and the enum cell', () => {
    render(<DataTable resource={contacts} rows={[{ id: '1', taxId: '5417', kind: 'person' }]} />)
    expect(screen.getByText('NIF')).toBeTruthy()
    // The stored value never appears — the whole point of the exercise.
    expect(screen.getByText('Pessoa')).toBeTruthy()
    expect(screen.queryByText('person')).toBeNull()
  })

  it('labels the field and its options in the form', () => {
    render(<ResourceForm resource={contacts} onSubmit={() => {}} chooseLabel="Escolha…" submitLabel="Guardar" />)
    expect(screen.getByLabelText('NIF')).toBeTruthy()
    const options = [...screen.getByLabelText('Tipo').querySelectorAll('option')]
    expect(options.map((o) => o.textContent)).toEqual(['Escolha…', 'Pessoa', 'Empresa'])
    // The submitted value stays the stored one.
    expect(options.map((o) => o.getAttribute('value'))).toEqual(['', 'person', 'company'])
  })

  it('leaves an unconfigured resource in English', () => {
    const plain = defineResource({ name: 'contacts', schema: ContactSchema, columns: ['kind'] })
    render(<DataTable resource={plain} rows={[{ id: '1', kind: 'person' }]} />)
    expect(screen.getByText('Kind')).toBeTruthy()
    expect(screen.getByText('person')).toBeTruthy()
  })
})
