import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineResource, fieldsFromSchema, formView, optionLabel, tableView } from '../src/index.js'

/**
 * B14 · field labels and translated enum options.
 *
 * `humanize()` derives every label from the field name, which is an English
 * transformation of an identifier: `taxId` becomes 'Tax Id', and an enum's
 * options come out as the raw database values — `person`, `bi`. In an
 * application written in another language the generated form ends up half in
 * English and half in storage values, which is what pushed one application to
 * hand-write the forms the kit was meant to generate.
 */

const ContactSchema = z.object({
  id: z.string(),
  taxId: z.string(),
  kind: z.enum(['person', 'company']),
  idDocumentType: z.enum(['bi', 'passport']).optional(),
})

const CreateContactSchema = z.object({
  taxId: z.string(),
  kind: z.enum(['person', 'company']),
})

const fields = {
  taxId: { label: 'NIF' },
  kind: { label: 'Tipo', options: { person: 'Pessoa', company: 'Empresa' } },
}

describe('F-25 · configured field labels', () => {
  it('overrides the humanized label', () => {
    const [taxId] = fieldsFromSchema(z.object({ taxId: z.string() }), { taxId: { label: 'NIF' } })
    expect(taxId?.label).toBe('NIF')
  })

  it('leaves unconfigured fields exactly as they were', () => {
    // The descriptor of a resource that configures nothing has to stay
    // byte-identical: `optionLabels` is absent, not an identity map.
    expect(fieldsFromSchema(ContactSchema)).toEqual(fieldsFromSchema(ContactSchema, {}))
    expect(fieldsFromSchema(ContactSchema)[2]).not.toHaveProperty('optionLabels')
  })

  it('labels enum options without touching the values', () => {
    const [kind] = fieldsFromSchema(z.object({ kind: z.enum(['person', 'company']) }), fields)
    // The value is what is stored and validated; only the display changes.
    expect(kind?.options).toEqual(['person', 'company'])
    expect(kind?.optionLabels).toEqual({ person: 'Pessoa', company: 'Empresa' })
  })

  it('falls back to the raw value for an option left unlabelled', () => {
    const [kind] = fieldsFromSchema(z.object({ kind: z.enum(['person', 'company']) }), {
      kind: { options: { person: 'Pessoa' } },
    })
    expect(optionLabel(kind!, 'person')).toBe('Pessoa')
    expect(optionLabel(kind!, 'company')).toBe('company')
  })
})

describe('F-25 · resource wiring', () => {
  const contacts = defineResource({
    name: 'contacts',
    label: 'Contactos',
    schema: ContactSchema,
    createSchema: CreateContactSchema,
    fields,
  })

  it('applies the same map to columns, entity fields and both form modes', () => {
    // One map, keyed by field name — the create form and the table must not
    // need separate copies of the same translation.
    expect(contacts.columns().map((f) => f.label)).toEqual(['Id', 'NIF', 'Tipo', 'Id Document Type'])
    expect(contacts.formFields('create').map((f) => f.label)).toEqual(['NIF', 'Tipo'])
    expect(contacts.formFields('update').map((f) => f.label)).toEqual(['NIF', 'Tipo'])
  })

  it('reaches the views the React layers render', () => {
    expect(tableView(contacts, []).columns[1]?.label).toBe('NIF')
    const kind = formView(contacts).fields.find((f) => f.name === 'kind')
    expect(kind?.optionLabels?.['company']).toBe('Empresa')
  })

  it('ignores a name that is not a field', () => {
    // A renamed field leaves a stale key behind. Failing the whole resource
    // over a translation would be a poor trade.
    const r = defineResource({ name: 'contacts', schema: ContactSchema, fields: { gone: { label: 'X' } } })
    expect(r.fields().map((f) => f.name)).toEqual(['id', 'taxId', 'kind', 'idDocumentType'])
  })
})
