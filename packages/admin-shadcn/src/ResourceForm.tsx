import { formView, type Field, type FormMode, type Resource } from '@machize/admin'
import { useState, type ChangeEvent, type FormEvent } from 'react'
import { cn } from './lib/cn.js'
import { Button } from './ui/button.js'
import { Input } from './ui/input.js'
import { Label } from './ui/label.js'

export interface ResourceFormProps {
  resource: Resource
  initialValues?: Record<string, unknown>
  mode?: FormMode
  onSubmit: (data: Record<string, unknown>) => void | Promise<void>
  submitLabel?: string
}

/** shadcn-styled form generated from a resource's fields, validated with its schema. */
export function ResourceForm({
  resource,
  initialValues = {},
  mode = 'create',
  onSubmit,
  submitLabel = 'Save',
}: ResourceFormProps) {
  const view = formView(resource, initialValues, mode)
  const [values, setValues] = useState<Record<string, unknown>>(initialValues)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const set = (name: string, value: unknown) => setValues((current) => ({ ...current, [name]: value }))

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const result = resource.validate(values, mode)
    if (!result.success) {
      setErrors(result.errors ?? {})
      return
    }
    setErrors({})
    await onSubmit(result.data as Record<string, unknown>)
  }

  return (
    <form onSubmit={handleSubmit} aria-label={`${resource.label} form`} className="space-y-4">
      {view.fields.map((field) => (
        <div key={field.name} className="space-y-2">
          <Label htmlFor={field.name}>{field.label}</Label>
          <FieldControl field={field} value={values[field.name]} onChange={(value) => set(field.name, value)} />
          {errors[field.name] ? (
            <p role="alert" data-field={field.name} className="text-sm font-medium text-destructive">
              {errors[field.name]}
            </p>
          ) : null}
        </div>
      ))}
      <Button type="submit">{submitLabel}</Button>
    </form>
  )
}

interface FieldControlProps {
  field: Field
  value: unknown
  onChange: (value: unknown) => void
}

const selectClass =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

function FieldControl({ field, value, onChange }: FieldControlProps) {
  const id = field.name
  const text = value === undefined || value === null ? '' : String(value)

  if (field.type === 'boolean') {
    return (
      <input
        id={id}
        name={id}
        type="checkbox"
        checked={Boolean(value)}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)}
        className="h-4 w-4 rounded border-input"
      />
    )
  }

  if (field.type === 'enum') {
    return (
      <select
        id={id}
        name={id}
        value={text}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
        className={cn(selectClass)}
      >
        <option value="" disabled>
          Select…
        </option>
        {field.options?.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    )
  }

  if (field.type === 'number') {
    return (
      <Input
        id={id}
        name={id}
        type="number"
        value={text}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onChange(event.target.value === '' ? undefined : Number(event.target.value))
        }
      />
    )
  }

  return (
    <Input
      id={id}
      name={id}
      type={field.type === 'date' ? 'date' : 'text'}
      value={text}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    />
  )
}
