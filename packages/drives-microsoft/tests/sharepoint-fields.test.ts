import { describe, expect, it } from 'vitest'
import {
  flattenFields,
  microsoftDrive,
  sharePointFieldsOf,
  SHAREPOINT_MAX_FIELDS,
  SHAREPOINT_MAX_VALUE_CHARS,
  toDriveItem,
} from '../src/index.js'
import { connect, harness } from './helpers.js'

/** A document-library item as Graph returns it with `$expand=listItem($expand=fields(...))`. */
const SHAREPOINT_ITEM = {
  id: '01DOC',
  name: 'contract.pdf',
  parentReference: { driveId: 'b!lib', id: 'root' },
  file: { mimeType: 'application/pdf' },
  listItem: {
    fields: {
      '@odata.etag': '"abc,1"',
      id: '7',
      Matter: { LookupId: 12, LookupValue: 'ACME v. Globex' },
      Reviewer: { LookupId: 3, LookupValue: 'Ana Silva', Email: 'ana@firm.test' },
      Status: 'Signed',
      Tags: [{ Label: 'urgent', TermGuid: 'x' }, { Label: 'nda', TermGuid: 'y' }],
      Pages: 14,
      Archived: false,
      Notes: null,
      Weird: { Something: 'else' },
      AuthorLookupId: '9',
    },
  },
}

const COLUMNS = ['Matter', 'Reviewer', 'Status', 'Tags', 'Pages', 'Archived', 'Notes', 'Weird', 'Missing']

describe('SharePoint list item fields', () => {
  it('flattens lookup, person, managed-metadata and primitive columns, allow-listed only', () => {
    const item = toDriveItem(SHAREPOINT_ITEM, COLUMNS)
    expect(item.raw).toEqual({
      driveId: 'b!lib',
      listItemFields: {
        Matter: 'ACME v. Globex',
        Reviewer: 'ana@firm.test',
        Status: 'Signed',
        Tags: 'urgent; nda',
        Pages: 14,
        Archived: false,
        Notes: null,
      },
    })
    expect(sharePointFieldsOf(item)).toMatchObject({ Matter: 'ACME v. Globex' })
    // Graph's own columns never ride along unless asked for.
    expect(sharePointFieldsOf(item)).not.toHaveProperty('AuthorLookupId')
    expect(sharePointFieldsOf(item)).not.toHaveProperty('@odata.etag')
  })

  it('leaves raw exactly { driveId } when the option is unset, even if Graph sent a list item', () => {
    const item = toDriveItem(SHAREPOINT_ITEM)
    expect(item.raw).toEqual({ driveId: 'b!lib' })
    expect(sharePointFieldsOf(item)).toBeUndefined()
  })

  it('omits the key for a personal OneDrive item with no list item', () => {
    const { listItem: _drop, ...personal } = SHAREPOINT_ITEM
    const item = toDriveItem(personal, COLUMNS)
    expect(item.raw).toEqual({ driveId: 'b!lib' })
    expect(sharePointFieldsOf(item)).toBeUndefined()
  })

  it('caps the number of columns and the length of a value', () => {
    const many: Record<string, unknown> = {}
    const names: string[] = []
    for (let i = 0; i < SHAREPOINT_MAX_FIELDS + 10; i++) {
      many[`C${i}`] = 'v'
      names.push(`C${i}`)
    }
    expect(Object.keys(flattenFields(many, names)!)).toHaveLength(SHAREPOINT_MAX_FIELDS)
    const long = flattenFields({ Long: 'x'.repeat(5000) }, ['Long'])!
    expect((long['Long'] as string).length).toBe(SHAREPOINT_MAX_VALUE_CHARS)
  })

  it('refuses a column name that is not a SharePoint internal name, at configuration time', () => {
    expect(() => microsoftDrive({ clientId: 'x', listItemFields: ['Matter)),fields($select=*'] })).toThrow(TypeError)
    expect(() => microsoftDrive({ clientId: 'x', listItemFields: Array.from({ length: 65 }, (_, i) => `C${i}`) })).toThrow(
      TypeError,
    )
  })

  it('expands the columns on listings and surfaces them through the engine', async () => {
    const h = harness({
      server: { files: [{ id: '01DOC', name: 'contract.pdf', content: 'x', listItemFields: { Matter: { LookupValue: 'ACME' } } }] },
      provider: { listItemFields: ['Matter'] },
    })
    const view = await connect(h)
    const page = await h.drives.listItems(view.id)
    const url = decodeURIComponent(h.graph.requests.at(-1)!.url)
    expect(url).toContain('$expand=listItem($expand=fields($select=Matter))')
    expect(sharePointFieldsOf(page.items[0]!)).toEqual({ Matter: 'ACME' })
  })

  it('sends no $expand when the option is unset', async () => {
    const h = harness({ server: { files: [{ id: '01DOC', name: 'contract.pdf', content: 'x' }] } })
    const view = await connect(h)
    await h.drives.listItems(view.id)
    expect(h.graph.requests.at(-1)!.url).not.toContain('expand')
  })
})
