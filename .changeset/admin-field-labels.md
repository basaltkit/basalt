---
'@basaltkit/admin': minor
'@basaltkit/admin-react': minor
'@basaltkit/admin-shadcn': minor
---

`defineResource` accepts field labels and enum option labels.

Every label was derived from the field name through `humanize()`, which is an
English transformation of an identifier — `taxId` reads *Tax Id*, `idDocumentNumber`
reads *Id Document Number* — and an enum's options came out as the stored values:
`person`, `company`, `bi`. In an application written in another language the
generated form ends up half in English and half in database values, which is
enough to make hand-writing the form the easier option. It is not only a
translation problem: an English admin whose field name is the developer's name
for the thing has it too.

```ts
defineResource({
  name: 'contacts',
  schema: ContactSchema,
  fields: {
    taxId: { label: 'NIF' },
    kind: { label: 'Tipo', options: { person: 'Pessoa', company: 'Empresa' } },
  },
})
```

One map, keyed by field name, covering the table and both form modes — the same
translation should not need three copies.

**Labelling never changes what is stored.** `field.options` still holds
`['person', 'company']`, which is what the form submits and the schema
validates; the display text lands in a separate `field.optionLabels`, read
through the new `optionLabel(field, value)`. Making `options` value/label pairs
would have read better and broken every renderer, including third-party ones;
this way a renderer that has never heard of the feature shows exactly what it
shows today. An option left unlabelled keeps its raw value, and a key naming no
field is ignored — a rename leaves stale entries behind, and refusing to
describe the resource over a leftover translation would be a poor trade.

`DataTable` shows the label in enum cells too: a table reading `person` beside a
form reading *Pessoa* is worse than either alone. `formatCell` now takes a
`Field` as well as a bare `FieldType`, which behaves as before. `ResourceForm`
gains `chooseLabel` for an empty select's placeholder, mirroring `submitLabel` —
the last hardcoded English string inside a translated form.
