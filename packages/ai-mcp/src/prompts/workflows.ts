import type { McpPromptDef } from '@basaltkit/mcp-core'

/** A user-role text prompt message. */
function user(text: string) {
  return { role: 'user' as const, content: { type: 'text' as const, text } }
}

/**
 * Workflow prompt templates. Each encodes the SAFE loop
 * (analyze → plan → make **preview** → review → make apply) and names the real
 * tools/resources, so even a naive agent follows the preview-before-write path.
 */
export function workflowPrompts(): McpPromptDef[] {
  return [
    {
      name: 'plan-feature',
      description: 'Plan and safely implement a feature in this BasaltKit project.',
      arguments: [{ name: 'request', description: 'What to build, in natural language.', required: true }],
      get(args) {
        const request = args['request'] ?? '<describe the feature>'
        return {
          description: `Safely build: ${request}`,
          messages: [
            user(
              [
                `You are working in a BasaltKit project. Build this feature: "${request}".`,
                '',
                'Follow the safe workflow — never write before previewing:',
                '1. Read the resources basalt://project/context and basalt://project/analysis to ground yourself in the stack (HTTP/ORM/tenancy/auth/RBAC/audit).',
                '2. Call basalt_plan with the request to get an ArchitecturePlan.',
                '3. Call basalt_make with mode:"preview" (the default) and that plan. Inspect preview.perFile diffs and preview.clashes. Do NOT apply blindly.',
                '4. Call basalt_review with the plan and the preview result to catch tenancy/security/RBAC/validation issues.',
                '5. Only if the preview and review look right, call basalt_make with mode:"apply" and the same plan. Add force:true only to overwrite existing files; add migrate:true only to run prisma db push.',
              ].join('\n'),
            ),
          ],
        }
      },
    },
    {
      name: 'scaffold-resource',
      description: 'Scaffold a single resource (schema, repository, service, routes, tests) safely.',
      arguments: [
        { name: 'name', description: 'Resource name, e.g. Patient.', required: true },
        { name: 'fields', description: 'Optional field list, e.g. "name:String, birthDate:DateTime".', required: false },
      ],
      get(args) {
        const name = args['name'] ?? '<Resource>'
        const fields = args['fields']
        const withFields = fields ? ` with fields: ${fields}` : ''
        return {
          description: `Scaffold the ${name} resource`,
          messages: [
            user(
              [
                `Scaffold a new resource "${name}"${withFields} in this BasaltKit project.`,
                '',
                '1. Call basalt_analyze to confirm the stack (Prisma / tenancy / RBAC / audit).',
                `2. Call basalt_plan with a request describing the ${name} resource${withFields}.`,
                '3. Call basalt_make mode:"preview" — inspect the diffs; if the project is multi-tenant, confirm the model carries tenantId.',
                '4. Call basalt_make mode:"apply" once the preview is correct. If a Prisma model was added, re-run with migrate:true (prisma db push) or run it yourself, then restart the dev server.',
              ].join('\n'),
            ),
          ],
        }
      },
    },
    {
      name: 'harden-tenancy',
      description: 'Audit and harden multi-tenant isolation.',
      get() {
        return {
          description: 'Harden multi-tenant isolation',
          messages: [
            user(
              [
                'Audit and harden multi-tenant isolation in this BasaltKit project.',
                '',
                '1. Read basalt://project/diagnostics (or call basalt_doctor) and focus on the tenancy findings.',
                '2. basalt_doctor returns in-memory fix previews (it never writes) — review the files each fix would change.',
                '3. Apply the fixes you trust deliberately, then re-run basalt_doctor and confirm no tenancy errors remain.',
              ].join('\n'),
            ),
          ],
        }
      },
    },
    {
      name: 'add-rbac',
      description: 'Add RBAC permission guards to an existing resource.',
      arguments: [{ name: 'resource', description: 'Resource to guard, e.g. Invoice.', required: true }],
      get(args) {
        const resource = args['resource'] ?? '<Resource>'
        return {
          description: `Add RBAC to ${resource}`,
          messages: [
            user(
              [
                `Add RBAC permission guards to the "${resource}" resource.`,
                '',
                '1. Call basalt_analyze to confirm @basaltkit/permissions (RBAC) is enabled.',
                `2. Call basalt_plan for a change that registers ${resource}.view/create/update/delete permissions and guards the routes.`,
                '3. Call basalt_make mode:"preview" — confirm the route guards and the *.permissions.ts file are generated.',
                '4. Call basalt_make mode:"apply" once correct, then grant the permissions to your roles during seed/setup.',
              ].join('\n'),
            ),
          ],
        }
      },
    },
  ]
}
