# @basaltkit/admin-shadcn

React components styled with **shadcn/ui** for the `@basaltkit/admin` engine: visual primitives (Button, Input, Table, Card, Badge…) plus already-styled versions of `DataTable` and `ResourceForm`. You need this when you want a good-looking admin panel "out of the box", with Tailwind CSS — it's the package the `create-basalt --ui` scaffold uses.

## What this module solves

`@basaltkit/admin-react` generates correct tables and forms, but in plain, unstyled HTML. This package takes the next step: the same components, with the look of **shadcn/ui** — a very popular component set in the React ecosystem, built on top of **Tailwind CSS** (a way of styling by writing utility classes like `rounded-md` or `text-sm` directly on elements).

Besides the styled `DataTable` and `ResourceForm`, the package exports the shadcn primitives themselves — `Button`, `Input`, `Label`, `Table`, `Card`, `Badge` — so you can build the rest of your panel (headers, metric cards, action buttons) with the same look, without copying shadcn's files into your project.

An important note: Tailwind classes only produce colors and spacing if your app has **Tailwind CSS configured** with shadcn's theme variables (colors like `--primary`, `--border`, etc.). The `create-basalt --ui` scaffold takes care of this for you; if you're integrating by hand, see the installation section.

## Installation

```bash
pnpm add @basaltkit/admin-shadcn @basaltkit/admin zod
```

Requirements:

1. **`react` >= 18** (peer dependency — you install it).
2. **Tailwind CSS** configured in your project, with the shadcn theme (the CSS variables `--background`, `--primary`, `--destructive`, etc. — see [ui.shadcn.com/docs/installation](https://ui.shadcn.com/docs/installation)).
3. In `tailwind.config`, include this package's files in `content`, so Tailwind generates the classes used here:

```js
// tailwind.config.js
export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './node_modules/@basaltkit/admin-shadcn/dist/**/*.js', // ← important
  ],
  // ... rest of the shadcn config (colors, radius, etc.)
}
```

> Shortcut: `pnpm create basalt my-app --ui` generates a complete project (API + Vite/React frontend) with all of this already configured.

## Get started in 5 minutes

**Step 1 — Define the resource** (same as `@basaltkit/admin` — the logic is shared):

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

export const source = memoryDataSource<{
  id: string
  name: string
  status: string
  archived: boolean
}>([{ id: 'p1', name: 'Apollo', status: 'draft', archived: false }])
```

**Step 2 — Build the page** with the styled components:

```tsx
// ProjectsPage.tsx
import { useState } from 'react'
import { useList } from '@basaltkit/admin-react' // data hook (optional but handy)
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  ResourceForm,
} from '@basaltkit/admin-shadcn'
import { projects, source } from './resources'

export function ProjectsPage() {
  const { data, loading, reload } = useList(source)
  const [toCreate, setToCreate] = useState(false)

  if (loading) return <p>Loading…</p>

  return (
    <Card>
      <CardHeader>
        <CardTitle>{projects.label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={() => setToCreate((v) => !v)}>New project</Button>

        {toCreate ? (
          <ResourceForm
            resource={projects}
            onSubmit={async (values) => {
              await source.create(values)
              setToCreate(false)
              await reload()
            }}
          />
        ) : null}

        <DataTable resource={projects} rows={data} emptyLabel="No projects" />
      </CardContent>
    </Card>
  )
}
```

**Step 3 — What you see on screen:** a card with rounded corners and a shadow, the title "Projects", a primary "New project" button, and the shadcn table — subtle headers, rows with *hover*, and the boolean "Archived" column shown as a **badge** (a colored tag): "Yes" with a primary background, "No" with a secondary background. The form appears with rounded inputs, aligned labels, and error messages in red (`text-destructive`).

## Usage guide

### `DataTable` — a shadcn table derived from the schema

Same props as the `DataTable` from `@basaltkit/admin-react`; only the presentation changes: it uses the `Table*` primitives, boolean cells become `Badge` ("Yes" = `default` variant, "No" = `secondary`), dates formatted as `YYYY-MM-DD`, and with `onRowClick` rows get `cursor-pointer`.

```tsx
import { DataTable } from '@basaltkit/admin-shadcn'
import { projects } from './resources'

<DataTable
  resource={projects}
  rows={[{ id: 'p1', name: 'Apollo', status: 'draft', archived: true }]}
  onRowClick={(row) => console.log(row)}
  emptyLabel="No records"
/>
```

### `ResourceForm` — a generated, validated shadcn form

Same behavior as the `ResourceForm` from `@basaltkit/admin-react` (a controlled form, validates on submit, shows per-field errors, only calls `onSubmit` with valid data), with shadcn visuals: styled `Label` + `Input`, `<select>` matching the input style, errors in `text-destructive`, primary `Button`.

```tsx
import { ResourceForm } from '@basaltkit/admin-shadcn'
import { projects, source } from './resources'

<ResourceForm
  resource={projects}
  mode="update"
  initialValues={{ name: 'Apollo', status: 'draft' }}
  submitLabel="Save"
  onSubmit={async (values) => { await source.update('p1', values) }}
/>
```

Inputs per field type: `string`/`unknown` → text `Input`; `number` → numeric `Input`; `date` → date `Input`; `boolean` → checkbox; `enum` → styled `<select>` with the options.

### shadcn primitives

All accept the corresponding element's normal HTML props (including `className` to add Tailwind classes, merged via `cn`).

**`Button`** — button with visual variants:

```tsx
import { Button } from '@basaltkit/admin-shadcn'

<Button>Save</Button>
<Button variant="destructive" size="sm">Delete</Button>
<Button variant="outline">Cancel</Button>
<Button asChild variant="link">
  <a href="/docs">Documentation</a>  {/* asChild: applies the style to the child */}
</Button>
```

**`Input` and `Label`** — text field and label:

```tsx
import { Input, Label } from '@basaltkit/admin-shadcn'

<div className="space-y-2">
  <Label htmlFor="email">Email</Label>
  <Input id="email" type="email" placeholder="you@example.com" />
</div>
```

**`Table` and family** — a hand-composed table (when the automatic `DataTable` isn't enough):

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@basaltkit/admin-shadcn'

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Name</TableHead>
      <TableHead>Status</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>Apollo</TableCell>
      <TableCell>draft</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

**`Card` and family** — card with header and content:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@basaltkit/admin-shadcn'

<Card>
  <CardHeader>
    <CardTitle>MRR</CardTitle>
  </CardHeader>
  <CardContent>1 250 €</CardContent>
</Card>
```

**`Badge`** — small status tag:

```tsx
import { Badge } from '@basaltkit/admin-shadcn'

<Badge>Active</Badge>
<Badge variant="secondary">Draft</Badge>
<Badge variant="destructive">Overdue</Badge>
<Badge variant="outline">Beta</Badge>
```

**`cn`** — utility to merge Tailwind classes without conflicts (the last one wins):

```ts
import { cn } from '@basaltkit/admin-shadcn'

cn('px-2', 'px-4')                        // 'px-4'
cn('text-sm', condition && 'font-bold')   // merges conditionally
```

## API reference

### `DataTable` (component)

| Prop | Type | Required? | Default | Description |
|---|---|---|---|---|
| `resource` | `Resource` | Yes | — | Resource from `defineResource` (defines the columns). |
| `rows` | `Record<string, unknown>[]` | Yes | — | Rows to display. |
| `onRowClick` | `(row) => void` | No | — | Makes rows clickable (`cursor-pointer`). |
| `emptyLabel` | `string` | No | `'No records'` | Centered text shown when there are no rows. |

### `ResourceForm` (component)

| Prop | Type | Required? | Default | Description |
|---|---|---|---|---|
| `resource` | `Resource` | Yes | — | Resource (fields + validation). |
| `initialValues` | `Record<string, unknown>` | No | `{}` | Pre-filled values. |
| `mode` | `'create' \| 'update'` | No | `'create'` | Selects the validation schema. |
| `onSubmit` | `(data) => void \| Promise<void>` | Yes | — | Receives data validated by Zod. |
| `submitLabel` | `string` | No | `'Save'` | Button text. |

### `Button` (component)

Extends `ButtonHTMLAttributes<HTMLButtonElement>` plus:

| Prop | Type | Required? | Default | Description |
|---|---|---|---|---|
| `variant` | `'default' \| 'destructive' \| 'outline' \| 'secondary' \| 'ghost' \| 'link'` | No | `'default'` | Visual style. |
| `size` | `'default' \| 'sm' \| 'lg' \| 'icon'` | No | `'default'` | Size. |
| `asChild` | `boolean` | No | `false` | Applies the style to the child element (via Radix Slot) instead of rendering a `<button>`. |

`buttonVariants({ variant?, size? })` (Advanced) — returns the class string, for styling other elements as buttons.

### `Badge` (component)

Extends `HTMLAttributes<HTMLDivElement>` plus:

| Prop | Type | Required? | Default | Description |
|---|---|---|---|---|
| `variant` | `'default' \| 'secondary' \| 'destructive' \| 'outline'` | No | `'default'` | Visual style. |

`badgeVariants({ variant? })` (Advanced) — returns the class string.

### Remaining primitives

| Export | Renders | Props |
|---|---|---|
| `Input` | Styled `<input>` | `InputProps` = `InputHTMLAttributes<HTMLInputElement>` |
| `Label` | Styled `<label>` | `LabelProps` = `LabelHTMLAttributes<HTMLLabelElement>` |
| `Table` | `<table>` in a horizontally-scrollable container | HTML attributes of `<table>` |
| `TableHeader` / `TableBody` | `<thead>` / `<tbody>` | HTML attributes of the section |
| `TableRow` | `<tr>` with hover | HTML attributes of `<tr>` |
| `TableHead` / `TableCell` | `<th>` / `<td>` | HTML attributes of the cell |
| `Card` / `CardHeader` / `CardTitle` / `CardContent` | Styled `<div>`s | `HTMLAttributes<HTMLDivElement>` |

All accept `className` and forward `ref` (except `Badge`, which is a plain function).

### `cn(...inputs): string` (function)

Merges conditional classes (`clsx`) and resolves Tailwind conflicts (`tailwind-merge`). Accepts strings, arrays, `{ class: condition }` objects, `false`/`undefined` (ignored).

### Exported types

`DataTableProps`, `ResourceFormProps`, `ButtonProps`, `InputProps`, `LabelProps`, `BadgeProps`.

## Common errors and solutions (FAQ)

**"The components appear without colors/styling."** Two common causes: (1) Tailwind isn't scanning this package's files — add `'./node_modules/@basaltkit/admin-shadcn/dist/**/*.js'` to `content` in `tailwind.config`; (2) the shadcn theme variables (`--primary`, `--border`, …) are missing from your global CSS — follow the shadcn/ui installation guide or use the `create-basalt --ui` scaffold.

**"The button has a transparent/odd background."** Colors come from the shadcn theme's CSS variables. Without `--primary` and friends defined on `:root`, classes like `bg-primary` have no value.

**"`asChild` throws a `React.Children.only` error."** With `asChild`, `Button` requires exactly **one** child element (e.g., a single `<a>`). This comes from Radix Slot.

**"`ResourceForm`'s `onSubmit` doesn't fire."** Validation failed — look for red text below the field (`role="alert"`). Behavior is identical to `@basaltkit/admin-react`.

**"I changed `initialValues` and the form didn't update."** Initial values are only read on mount. Remount with a different `key`: `<ResourceForm key={record.id} … />`.

**"I want a hook to load data — I don't see `useList` here."** `useList` lives in `@basaltkit/admin-react` (this package only ships visual components). You can use both packages together without issue.

## How it connects to other modules

- **`@basaltkit/admin`** — the headless engine: this package renders the `tableView`/`formView` view models and validates with `resource.validate`. Resources are defined there.
- **`@basaltkit/admin-react`** — the unstyled version of the same `DataTable`/`ResourceForm` (identical props), plus the `useList` hook and `formatCell`. Switching between the two packages is just switching the import.
- **`@basaltkit/dashboard`** — defines a panel's sections and metrics; uses these primitives (`Card`, `Badge`, `DataTable`) to display them.
- **`@basaltkit/sdk`** — the typed HTTP client; in the frontend generated by the scaffold, data arrives via the SDK and is shown with these components.
- **`create-basalt --ui`** — the Basalt scaffold generates a Vite + React frontend already configured with Tailwind, the shadcn theme, and this package talking to the API through `@basaltkit/sdk` (`--ui` projects use pnpm workspaces).
