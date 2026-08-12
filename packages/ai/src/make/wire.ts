import { names } from '@basaltkit/generator'

/**
 * Fase 4 auto-wiring: turn the plan's permissions and audit events into real code
 * inside the generated scaffold, using the framework's official mechanisms —
 * route `meta.can` guards (@basaltkit/permissions) and `AUDIT.record()`
 * (@basaltkit/audit). Never invents APIs (spec §22). Each injector degrades
 * gracefully: if its anchor isn't found, it returns `injected: false` and the
 * scaffold lands unchanged.
 */

type Action = 'view' | 'create' | 'update' | 'delete'

function insertAfterLastImport(content: string, line: string): string {
  const imports = [...content.matchAll(/^import .*$/gm)]
  const last = imports.at(-1)
  if (!last || last.index === undefined) return `${line}\n${content}`
  const at = last.index + last[0].length
  return `${content.slice(0, at)}\n${line}${content.slice(at)}`
}

function actionFor(method: string, url: string): Action | null {
  switch (method.toUpperCase()) {
    case 'GET':
      return 'view'
    case 'POST':
      return url.endsWith('/restore') ? 'update' : 'create'
    case 'PATCH':
    case 'PUT':
      return 'update'
    case 'DELETE':
      return 'delete'
    default:
      return null
  }
}

/**
 * Inject `meta: { can: '<prefix>.<action>' }` into every generated route, so the
 * permissions guard enforces it. `prefix` is taken from the plan's permissions
 * (e.g. `patients`).
 */
export function injectPermissionGuards(
  content: string,
  permissions: string[],
): { content: string; injected: boolean } {
  const prefix = permissions[0]?.split('.')[0]
  if (!prefix) return { content, injected: false }

  let injected = false
  const out = content.replace(
    /route\(\{\s*\n(\s*)method: '(\w+)',\s*\n\s*url: '([^']*)',/g,
    (match, indent: string, method: string, url: string) => {
      const action = actionFor(method, url)
      if (!action) return match
      injected = true
      return `route({\n${indent}method: '${method}',\n${indent}url: '${url}',\n${indent}meta: { can: '${prefix}.${action}' },`
    },
  )
  return { content: out, injected }
}

function eventFor(events: string[], suffix: 'created' | 'updated' | 'deleted'): string {
  const match = events.find((e) => e.endsWith(`.${suffix}`))
  if (match) return match
  const prefix = events[0]?.split('.')[0] ?? 'record'
  return `${prefix}.${suffix}`
}

/**
 * Inject audit recording into the generated service: the constructor receives an
 * `Audit`, and create/update/remove record their event after the repository call.
 */
export function injectAuditService(
  content: string,
  resourceName: string,
  events: string[],
): { content: string; injected: boolean } {
  const n = names(resourceName)
  const ctorAnchor = `constructor(private readonly repository: ${n.pascal}Repository) {}`
  if (!content.includes(ctorAnchor)) return { content, injected: false }

  let out = insertAfterLastImport(content, `import type { Audit } from '@basaltkit/audit'`)

  out = out.replace(
    ctorAnchor,
    `constructor(\n    private readonly repository: ${n.pascal}Repository,\n    private readonly audit: Audit,\n  ) {}`,
  )

  out = out.replace(
    `  create(input: Create${n.pascal}Input) {\n    return this.repository.create(input)\n  }`,
    `  async create(input: Create${n.pascal}Input) {\n    const created = await this.repository.create(input)\n    await this.audit.record('${eventFor(events, 'created')}', created)\n    return created\n  }`,
  )

  out = out.replace(
    `  update(id: string, input: Update${n.pascal}Input) {\n    return this.repository.update(id, input)\n  }`,
    `  async update(id: string, input: Update${n.pascal}Input) {\n    const updated = await this.repository.update(id, input)\n    if (updated) await this.audit.record('${eventFor(events, 'updated')}', updated)\n    return updated\n  }`,
  )

  out = out.replace(
    `  remove(id: string) {\n    return this.repository.delete(id)\n  }`,
    `  async remove(id: string) {\n    const removed = await this.repository.delete(id)\n    if (removed) await this.audit.record('${eventFor(events, 'deleted')}', { id })\n    return removed\n  }`,
  )

  return { content: out, injected: true }
}

/** Inject the `AUDIT` dependency into the generated plugin's service construction. */
export function injectAuditPlugin(
  content: string,
  resourceName: string,
): { content: string; injected: boolean } {
  const n = names(resourceName)
  const anchor = `new ${n.pascal}Service(c.get(${n.constant}_REPOSITORY))`
  if (!content.includes(anchor)) return { content, injected: false }

  let out = insertAfterLastImport(content, `import { AUDIT } from '@basaltkit/audit'`)
  out = out.replace(anchor, `new ${n.pascal}Service(c.get(${n.constant}_REPOSITORY), c.get(AUDIT))`)
  return { content: out, injected: true }
}
