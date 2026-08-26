<p align="center">
  <a href="https://basaltkit-docs.pages.dev">
    <img src="https://basaltkit-docs.pages.dev/social-card.png" alt="Basalt" width="440">
  </a>
</p>

# @basaltkit/admin-react

Ready-to-use React components for the `@basaltkit/admin` engine: a table (`DataTable`) and a form (`ResourceForm`) generated automatically from your Zod schemas, plus a hook (`useList`) for loading data. You need this when you want to put an admin panel on screen with React, without writing tables and forms by hand.

## What this module solves

`@basaltkit/admin` (the "engine") knows **what** to show — columns, fields, validation — but doesn't render anything. This package is the **React layer**: it turns those models into visible elements. A **React component** is a function that returns what appears on screen (written in JSX/TSX, an HTML-like syntax inside TypeScript); **props** are the parameters you pass to the component to configure it.

In practice: you define a resource once (e.g. "projects", with its Zod schema) and this package immediately gives you a table with readable headers and formatted cells (booleans as "Yes/No", dates as `2026-08-07`), and a form with the right input for each field type — text box for text, *checkbox* for true/false, dropdown (`<select>`) for enums, numeric input for numbers — already with validation and per-field error messages.

Important: the components in this package produce **plain, unstyled HTML** (`<table>`, `<form>`, `<input>`…). This is intentional — you apply whatever CSS you want. If you prefer already-styled components with Tailwind/shadcn, use the sibling package `@basaltkit/admin-shadcn`, which has exactly the same props.

## Installation

```bash
pnpm add @basaltkit/admin-react @basaltkit/admin zod
```

> Requirements: `react` >= 18 (peer dependency — you install it in your project). `@basaltkit/admin` comes as a direct dependency, but you need `zod` to write the schemas.

## Get started in 5 minutes

Let's build a mini project dashboard: a list and a creation form.

**Step 1 — Define the resource** (pure logic, no React — you can put it in a `resources.ts` file):

```ts
// resources.ts
import { z } from 'zod'
import { defineResource, memoryDataSource } from '@basaltkit/admin'

export const projects = defineResource({
  name: 'projects',
  schema: z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(['draft', 'published']),
    archived: z.boolean(),
  }),
  createSchema: z.object({
    name: z.string().min(3),
    status: z.enum(['draft', 'published']),
  }),
  columns: ['name', 'status', 'archived'],
})

// In-memory data source, just for experimenting:
export const source = memoryDataSource<{
  id: string
  name: string
  status: string
  archived: boolean
}>([{ id: 'p1', name: 'Apollo', status: 'draft', archived: false }])
```

**Step 2 — Create the screen** with the three main exports:

```tsx
// ProjectsPage.tsx
import { DataTable, ResourceForm, useList } from '@basaltkit/admin-react'
import { projects, source } from './resources'

export function ProjectsPage() {
  // useList loads the list when the component appears on screen
  const { data, loading, error, reload } = useList(source)

  if (loading) return <p>Loading…</p>
  if (error) return <p>Something went wrong.</p>

  return (
    <div>
      <h1>{projects.label}</h1>

      <DataTable
        resource={projects}
        rows={data}
        onRowClick={(row) => console.log('clicked', row)}
      />

      <h2>New project</h2>
      <ResourceForm
        resource={projects}
        onSubmit={async (values) => {
          await source.create(values) // save
          await reload()              // reload the table
        }}
      />
    </div>
  )
}
```

**Step 3 — What you see on screen:** a table with headers "Name", "Status", "Archived" (the boolean column shows "Yes"/"No"), and below it a form with a "Name" text box, a "Status" `<select>` with the `draft`/`published` options, and a "Save" button. If you type a name with fewer than 3 letters and click "Save", the error message appears below the field and nothing is saved.

## Usage guide

### `DataTable` — schema-derived table

Renders a resource's rows into a `<table>`. Columns come from `resource.columns()` and each cell is formatted by type with `formatCell`.

```tsx
import { DataTable } from '@basaltkit/admin-react'
import { projects } from './resources'

<DataTable
  resource={projects}
  rows={[{ id: 'p1', name: 'Apollo', status: 'draft', archived: true }]}
  emptyLabel="No records"                   // shown when rows is empty
  onRowClick={(row) => openDetail(row)}     // makes rows clickable
/>
```

On screen: header `Name | Status | Archived`, one row `Apollo | draft | Yes`. With no rows, a single cell with `emptyLabel` spans the full width.

### `ResourceForm` — generated and validated form

**Controlled** form (React holds the values as you type) generated from `resource.formFields(mode)`. On submit, it validates with `resource.validate(values, mode)`; on errors, it shows a message per field (element with `role="alert"`) and **does not** call `onSubmit`; without errors, it calls `onSubmit` with the data already validated and converted by Zod.

Create:

```tsx
import { ResourceForm } from '@basaltkit/admin-react'
import { projects, source } from './resources'

<ResourceForm
  resource={projects}
  onSubmit={async (values) => { await source.create(values) }}
/>
```

Edit (`update` mode, with initial values):

```tsx
<ResourceForm
  resource={projects}
  mode="update"
  initialValues={{ name: 'Apollo', status: 'draft' }}
  submitLabel="Save changes"
  onSubmit={async (values) => { await source.update('p1', values) }}
/>
```

Inputs generated per field type:

| Field type | Screen element | Delivered value |
|---|---|---|
| `string` | `<input type="text">` | `string` |
| `number` | `<input type="number">` | `number` (or `undefined` if empty) |
| `boolean` | `<input type="checkbox">` | `boolean` |
| `date` | `<input type="date">` | `string` (e.g. `'2026-08-07'`) |
| `enum` | `<select>` with the options | `string` |
| `unknown` | `<input type="text">` | `string` |

### `useList` — load a list of data

A **hook** is a special React function (starts with `use`) that gives a component superpowers — here, loading data from an `AdminDataSource` when the component mounts, with loading state, error, and manual reload.

```tsx
import { useList } from '@basaltkit/admin-react'
import { source } from './resources'

function List() {
  const { data, loading, error, reload } = useList(source, { page: 1, pageSize: 20, search: 'apo' })
  // data: loaded rows; loading: true while fetching;
  // error: the error thrown by the source (or null); reload(): fetches again.
  return loading ? <p>…</p> : <button onClick={() => void reload()}>Reload ({data.length})</button>
}
```

Note: `params` are compared by content (via `JSON.stringify`), so you can pass a new object on every render without triggering a request loop.

### `formatCell` — format a value for display

Used internally by `DataTable`; exported for use in your own tables.

```ts
import { formatCell } from '@basaltkit/admin-react'

formatCell(true, 'boolean')                    // 'Yes'
formatCell(false, 'boolean')                   // 'No'
formatCell(new Date('2026-08-07'), 'date')     // '2026-08-07'
formatCell(null, 'string')                     // ''
formatCell(42, 'number')                       // '42'
```

## API reference

### `DataTable` (component)

| Prop | Type | Required? | Default | Description |
|---|---|---|---|---|
| `resource` | `Resource` | Yes | — | The resource (from `defineResource`) that defines the columns. |
| `rows` | `Record<string, unknown>[]` | Yes | — | The rows to display. |
| `onRowClick` | `(row) => void` | No | — | Called with the clicked row. |
| `emptyLabel` | `string` | No | `'No records'` | Text shown when there are no rows. |

Each row's key is `row[resource.idField]` (or the index, if missing).

### `ResourceForm` (component)

| Prop | Type | Required? | Default | Description |
|---|---|---|---|---|
| `resource` | `Resource` | Yes | — | The resource that defines fields and validation. |
| `initialValues` | `Record<string, unknown>` | No | `{}` | Pre-filled values. |
| `mode` | `'create' \| 'update'` | No | `'create'` | Chooses the validation schema. |
| `onSubmit` | `(data) => void \| Promise<void>` | Yes | — | Receives the data validated/converted by Zod. |
| `submitLabel` | `string` | No | `'Save'` | Button text. |

Accessibility: the `<form>` has `aria-label` `"<resource label> form"`; each error is a `<span role="alert" data-field="<name>">`.

### `useList(source, params?)` (hook)

| Parameter | Type | Required? | Description |
|---|---|---|---|
| `source` | `AdminDataSource<T>` | Yes | Data source (from `@basaltkit/admin`). |
| `params` | `ListParams` (`{ page?, pageSize?, search? }`) | No | Listing parameters. |

Returns `UseListResult<T>`:

| Field | Type | Description |
|---|---|---|
| `data` | `T[]` | Loaded rows (`[]` initially). |
| `loading` | `boolean` | `true` while the request is in flight (starts as `true`). |
| `error` | `unknown` | Error thrown by `source.list` (or `null`). |
| `reload` | `() => Promise<void>` | Repeats the request manually. |

### `formatCell(value, type): string` (function)

| Parameter | Type | Description |
|---|---|---|
| `value` | `unknown` | The cell's value. |
| `type` | `FieldType` | Field type (from `@basaltkit/admin`). |

`null`/`undefined` → `''`; `boolean` → `'Yes'`/`'No'`; `date` → `YYYY-MM-DD` (or `String(value)` if the date is invalid); everything else → `String(value)`.

### Exported types

`DataTableProps`, `ResourceFormProps`, `UseListResult<T>` — the shapes described in the tables above.

## Common issues and solutions (FAQ)

**"The table/form appears with no styling at all."** This is expected behavior — this package emits plain HTML. Style it with your own CSS (e.g. `table { … }`) or use `@basaltkit/admin-shadcn` for already-styled components.

**"`onSubmit` is never called."** Validation failed. Look on screen for the messages below the fields (`role="alert"` elements). Check the `mode`: in `update` it validates with `updateSchema` (or `createSchema` as a fallback).

**"The date field returns text, not `Date`."** The browser's `<input type="date">` produces a `'YYYY-MM-DD'` string. If your schema requires `z.date()`, use `z.coerce.date()` in the input schema so Zod converts it automatically.

**"`useList` fetches data in an infinite loop."** `params` are stabilized by content, but `source` is compared by identity. Create the data source **outside** the component (or with `useMemo`) — if you create `memoryDataSource(...)` inside the component body, every render creates a new source and triggers a new request.

**"I changed `initialValues` and the form didn't update."** Initial values are only read on mount (it's a controlled form with internal state). To edit a different record, remount the component with a different `key`: `<ResourceForm key={row.id} … />`.

**"Error about React versions / invalid hooks."** Make sure there's a single copy of `react` >= 18 in the project (it's a peer dependency).

## How it connects to other modules

- **`@basaltkit/admin`** — the engine underneath: `DataTable` uses `tableView`, `ResourceForm` uses `formView` + `resource.validate`, and `useList` consumes any `AdminDataSource`. You define resources there; render them here.
- **`@basaltkit/admin-shadcn`** — visual alternative styled with shadcn/ui (Tailwind). Its `DataTable` and `ResourceForm` have the **same props** — switching packages is just switching the import.
- **`@basaltkit/dashboard`** — organizes several resources into navigable sections; uses these components to render each resource section.
- **`@basaltkit/sdk`** — implements `AdminDataSource` over the SDK's typed client so you can wire these components to a real Basalt backend.
