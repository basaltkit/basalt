import { useState } from 'react'
import { z } from 'zod'
import { defineResource } from '@machize/admin'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  ResourceForm,
} from '@machize/admin-shadcn'
import {
  computeBillingMetrics,
  defineDashboard,
  metricsSection,
  resourceSection,
} from '@machize/dashboard'
// Types only (erased) — the subscriptions runtime never enters the browser bundle.
import type { PlanDefinition, SubscriptionRecord } from '@machize/subscriptions'

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

// --- the dashboard model: sidebar sections, via @machize/dashboard -----------

const dashboard = defineDashboard({
  title: 'Machize Admin',
  sections: [metricsSection({ label: 'Overview' }), resourceSection(projects, { key: 'projects' })],
})

// --- billing metrics computed by @machize/dashboard (now browser-safe) --------

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
]
const metrics = computeBillingMetrics(subs, plans)

export function App() {
  const [active, setActive] = useState('overview')
  const [rows, setRows] = useState<Project[]>(seedProjects)
  const [dark, setDark] = useState(false)

  const toggleTheme = () => {
    const next = !dark
    document.documentElement.classList.toggle('dark', next)
    setDark(next)
  }

  return (
    <div className="flex min-h-screen">
      {/* sidebar — driven by dashboard.nav() */}
      <aside className="w-60 shrink-0 border-r bg-card px-3 py-5">
        <div className="mb-6 flex items-center gap-2 px-2">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary font-mono font-bold text-primary-foreground">
            M
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

      {/* main */}
      <main className="flex-1 px-8 py-6">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight">
            {dashboard.section(active)?.label}
          </h1>
          <Button variant="outline" size="sm" onClick={toggleTheme}>
            {dark ? 'Light' : 'Dark'}
          </Button>
        </header>

        {active === 'overview' ? (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="MRR" value={`$${metrics.mrr.toLocaleString()}`} hint="monthly recurring" />
              <Stat label="ARR" value={`$${metrics.arr.toLocaleString()}`} hint="annual run rate" />
              <Stat label="Active" value={String(metrics.active)} hint="paying subscriptions" />
              <Stat label="Trialing" value={String(metrics.trialing)} hint="in trial" />
            </div>
            <Card>
              <CardHeader>
                <CardTitle>Subscriptions by plan</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {Object.entries(metrics.byPlan).map(([plan, count]) => (
                  <Badge key={plan} variant="secondary">
                    {plan}: {count}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          </div>
        ) : (
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
      </main>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
        <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  )
}
