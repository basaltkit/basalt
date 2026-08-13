import { names } from '@basaltkit/generator'

/** Human summary for a generated CRUD route, from its method + url. */
function summaryFor(method: string, url: string, singular: string, plural: string): string {
  switch (method.toUpperCase()) {
    case 'GET':
      return url.includes(':id') ? `Get a ${singular}` : `List ${plural}`
    case 'POST':
      return url.endsWith('/restore') ? `Restore a ${singular}` : `Create a ${singular}`
    case 'PATCH':
    case 'PUT':
      return `Update a ${singular}`
    case 'DELETE':
      return `Delete a ${singular}`
    default:
      return `${singular} operation`
  }
}

/**
 * OpenAPI enrichment (spec §14): add a `summary` and `tags` to each generated
 * route's `meta`, merging into an existing `meta` (e.g. the `can` guard) or
 * creating one. `@basaltkit/http` renders these into the OpenAPI document.
 */
export function injectOpenApiMeta(content: string, entityName: string): { content: string; injected: boolean } {
  const n = names(entityName)
  const singular = n.kebab.replace(/-/g, ' ')
  const plural = n.pluralKebab.replace(/-/g, ' ')
  const tag = n.pascal
  let injected = false

  const out = content.replace(
    /route\(\{\s*\n(\s*)method: '(\w+)',\s*\n\s*url: '([^']*)',(?:\s*\n\s*meta: \{([^}]*)\},)?/g,
    (_match, indent: string, method: string, url: string, metaInner: string | undefined) => {
      const extra = `summary: '${summaryFor(method, url, singular, plural)}', tags: ['${tag}']`
      const meta = metaInner !== undefined ? `{ ${metaInner.trim()}, ${extra} }` : `{ ${extra} }`
      injected = true
      return `route({\n${indent}method: '${method}',\n${indent}url: '${url}',\n${indent}meta: ${meta},`
    },
  )
  return { content: out, injected }
}
