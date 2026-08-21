import { useMemo, useState } from 'react'
import { z } from 'zod'
import { defineResource } from '@basaltkit/admin'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  ResourceForm,
} from '@basaltkit/admin-shadcn'
import { buildOverview, standardDashboard, type Kpi, type OverviewModel } from '@basaltkit/dashboard'
// Types only (erased) — the subscriptions runtime never enters the browser bundle.
import type { PlanDefinition, SubscriptionRecord } from '@basaltkit/subscriptions'

// --- the resource: one Zod schema drives table + form + validation ---------

const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  tenant: z.string(),
  status: z.enum(['draft', 'active', 'archived']),
  seats: z.number(),
  billable: z.boolean(),
})
const CreateProject = z.object({
  name: z.string().min(3),
  tenant: z.string().min(2),
  status: z.enum(['draft', 'active', 'archived']),
  seats: z.number().int().positive(),
  billable: z.boolean().optional(),
})
const projects = defineResource({
  name: 'projects',
  label: 'Projects',
  schema: ProjectSchema,
  createSchema: CreateProject,
  columns: ['name', 'tenant', 'status', 'seats', 'billable'],
})

interface Project {
  id: string
  name: string
  tenant: string
  status: string
  seats: number
  billable: boolean
}
const seedProjects: Project[] = [
  { id: '1', name: 'Acme Billing', tenant: 'acme', status: 'active', seats: 12, billable: true },
  { id: '2', name: 'Globex Analytics', tenant: 'globex', status: 'draft', seats: 3, billable: false },
  { id: '3', name: 'Initech Portal', tenant: 'initech', status: 'active', seats: 40, billable: true },
]

// --- the ready-made dashboard: Overview → resources → Queues → Audit --------

const dashboard = standardDashboard({
  title: 'Basalt Admin',
  resources: [projects],
  queues: true,
  audit: true,
})

// --- the Overview snapshot, assembled by @basaltkit/dashboard (browser-safe) -

const plans: Record<string, PlanDefinition> = {
  free: { price: 0, features: {} },
  pro: { price: { monthly: 29, yearly: 290 }, features: {} },
  scale: { price: { monthly: 99, yearly: 990 }, features: {} },
}
const subs: SubscriptionRecord[] = [
  { billableId: 'acme', plan: 'scale', period: 'monthly', status: 'active' },
  { billableId: 'globex', plan: 'pro', period: 'yearly', status: 'active' },
  { billableId: 'initech', plan: 'pro', period: 'monthly', status: 'active' },
  { billableId: 'umbrella', plan: 'pro', period: 'monthly', status: 'trialing' },
  { billableId: 'soylent', plan: 'free', period: 'monthly', status: 'active' },
  { billableId: 'wayne', plan: 'pro', period: 'monthly', status: 'past_due' },
]
const auditLog = [
  { event: 'project.created' },
  { event: 'user.login' },
  { event: 'user.login' },
  { event: 'subscription.updated' },
  { event: 'user.login' },
  { event: 'project.deleted' },
]
const overview: OverviewModel = buildOverview({
  subscriptions: subs,
  plans,
  activeAtStart: 5,
  queue: { waiting: 8, active: 2, completed: 340, failed: 3, delayed: 1 },
  audit: auditLog,
})

const TONE: Record<NonNullable<Kpi['tone']>, string> = {
  default: 'border-border',
  positive: 'border-l-4 border-l-emerald-500',
  warning: 'border-l-4 border-l-amber-500',
  critical: 'border-l-4 border-l-red-500',
}

export function App() {
  const [active, setActive] = useState(dashboard.sections[0]?.key ?? 'overview')
  const [rows, setRows] = useState<Project[]>(seedProjects)
  const [dark, setDark] = useState(false)
  const section = useMemo(() => dashboard.section(active), [active])

  const toggleTheme = () => {
    const next = !dark
    document.documentElement.classList.toggle('dark', next)
    setDark(next)
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r bg-card px-3 py-5">
        <div className="mb-6 flex items-center gap-2 px-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary font-mono font-bold text-primary-foreground">
            B
          </div>
          <span className="font-semibold tracking-tight">{dashboard.title}</span>
        </div>
        <nav className="space-y-1">
          {dashboard.nav().map((item) => (
            <button
              key={item.key}
              onClick={() => setActive(item.key)}
              className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                active === item.key
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex-1 px-8 py-6">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">{section?.label}</h1>
          <Button variant="outline" size="sm" onClick={toggleTheme}>
            {dark ? 'Light' : 'Dark'}
          </Button>
        </header>

        {section?.kind === 'metrics' && <OverviewPage model={overview} />}

        {section?.kind === 'resource' && (
          <div className="grid gap-6 lg:grid-cols-[1.7fr_1fr]">
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>Projects</CardTitle>
                <Badge variant="secondary">{rows.length} total</Badge>
              </CardHeader>
              <CardContent>
                <DataTable resource={projects} rows={rows as unknown as Record<string, unknown>[]} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>New project</CardTitle>
              </CardHeader>
              <CardContent>
                <ResourceForm
                  resource={projects}
                  submitLabel="Create project"
                  onSubmit={(data) =>
                    setRows((current) => [
                      ...current,
                      { id: String(current.length + 1), billable: false, ...(data as Omit<Project, 'id'>) },
                    ])
                  }
                />
              </CardContent>
            </Card>
          </div>
        )}

        {section?.kind === 'queue' && overview.queue && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {(['waiting', 'active', 'completed', 'failed', 'delayed'] as const).map((state) => (
              <Stat
                key={state}
                label={state[0]!.toUpperCase() + state.slice(1)}
                value={String(overview.queue![state])}
                hint={state === 'failed' && overview.queue!.failed > 0 ? 'needs retry' : ''}
                tone={state === 'failed' && overview.queue!.failed > 0 ? 'critical' : 'default'}
              />
            ))}
            <Stat
              label="Health"
              value={overview.queue.healthy ? 'Healthy' : 'Degraded'}
              hint={`${overview.queue.total} jobs tracked`}
              tone={overview.queue.healthy ? 'positive' : 'critical'}
            />
          </div>
        )}

        {section?.kind === 'audit' && (
          <Card>
            <CardHeader>
              <CardTitle>Top events</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {(overview.topEvents ?? []).map((row) => (
                <div key={row.event} className="flex items-center justify-between text-sm">
                  <span className="font-mono">{row.event}</span>
                  <Badge variant="secondary">{row.count}</Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  )
}

function OverviewPage({ model }: { model: OverviewModel }) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {model.kpis.map((k) => (
          <Stat key={k.label} label={k.label} value={k.value} hint={k.hint ?? ''} tone={k.tone ?? 'default'} />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Subscriptions by plan</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {model.byPlan.map(({ plan, count }) => (
              <Badge key={plan} variant="secondary">
                {plan}: {count}
              </Badge>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By status</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {model.byStatus.map(({ status, count }) => (
              <Badge key={status} variant="secondary">
                {status}: {count}
              </Badge>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint: string; tone: NonNullable<Kpi['tone']> }) {
  return (
    <Card className={TONE[tone]}>
      <CardContent className="pt-6">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
        {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      </CardContent>
    </Card>
  )
}
