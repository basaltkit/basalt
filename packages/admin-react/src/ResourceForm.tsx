import { useState, type ChangeEvent, type FormEvent } from 'react'
import { formView, type Field, type FormMode, type Resource } from '@basaltkit/admin'

export interface ResourceFormProps {
  resource: Resource
  initialValues?: Record<string, unknown>
  mode?: FormMode
  onSubmit: (data: Record<string, unknown>) => void | Promise<void>
  submitLabel?: string
}

/** A controlled form generated from a resource's fields, validated with its schema. */
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
    <form onSubmit={handleSubmit} aria-label={`${resource.label} form`}>
      {view.fields.map((field) => (
        <div key={field.name}>
          <label htmlFor={field.name}>{field.label}</label>
          <FieldInput field={field} value={values[field.name]} onChange={(value) => set(field.name, value)} />
          {errors[field.name] ? (
            <span role="alert" data-field={field.name}>
              {errors[field.name]}
            </span>
          ) : null}
        </div>
      ))}
      <button type="submit">{submitLabel}</button>
    </form>
  )
}

interface FieldInputProps {
  field: Field
  value: unknown
  onChange: (value: unknown) => void
}

function FieldInput({ field, value, onChange }: FieldInputProps) {
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
      <input
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
    <input
      id={id}
      name={id}
      type={field.type === 'date' ? 'date' : 'text'}
      value={text}
      onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    />
  )
}
