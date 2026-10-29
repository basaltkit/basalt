/**
 * The ecosystem catalog the Architect plans with: each official package, the
 * capability it covers and the entry points an app wires. Without it the model
 * only knew the generator and rebuilt features (comments, files, notifications…)
 * as fresh resources instead of installing the package that already ships them.
 *
 * Kept in sync with `packages/*` by `tests/plan-packages.test.ts`.
 */
export interface EcosystemPackage {
  /** npm name, e.g. `@basaltkit/comments`. */
  name: string
  /** What it provides, in the words a request would use. */
  covers: string
  /** The plugin factory wired in src/app.ts. */
  plugin?: string
  /** Ready-made routes the app spreads into its route list. */
  routes?: string
  /** The Prisma-backed store package, when the default store is in-memory. */
  prisma?: string
}

export const ECOSYSTEM_PACKAGES: readonly EcosystemPackage[] = [
  { name: '@basaltkit/auth', covers: 'login, signup, JWT/sessions, password reset, MFA, OAuth, passkeys, API keys', plugin: 'authPlugin', prisma: '@basaltkit/auth-prisma' },
  { name: '@basaltkit/permissions', covers: 'roles, permissions, policies, route guards (RBAC)', plugin: 'permissionsPlugin', prisma: '@basaltkit/permissions-prisma' },
  { name: '@basaltkit/tenancy', covers: 'multi-tenancy: tenant resolution and tenant context', plugin: 'tenancyPlugin', prisma: '@basaltkit/tenancy-prisma' },
  { name: '@basaltkit/teams', covers: 'team members, roles inside a tenant, email invitations', plugin: 'teamsPlugin', routes: 'teamRoutes', prisma: '@basaltkit/teams-prisma' },
  { name: '@basaltkit/comments', covers: 'comment threads on any resource, @mentions, resolve/reopen', plugin: 'commentsPlugin', routes: 'commentRoutes', prisma: '@basaltkit/comments-prisma' },
  { name: '@basaltkit/activity', covers: 'user-facing activity feed / history of changes', plugin: 'activityPlugin', prisma: '@basaltkit/activity-prisma' },
  { name: '@basaltkit/audit', covers: 'append-only audit trail of state changes', plugin: 'auditPlugin', prisma: '@basaltkit/audit-prisma' },
  { name: '@basaltkit/notifications', covers: 'in-app and email notifications, per-user preferences', plugin: 'notificationsPlugin', routes: 'inAppRoutes', prisma: '@basaltkit/notifications-prisma' },
  { name: '@basaltkit/files', covers: 'file uploads and attachments, quotas, signed URLs', plugin: 'filesPlugin', routes: 'fileRoutes', prisma: '@basaltkit/files-prisma' },
  { name: '@basaltkit/files-versions', covers: 'document versions / revisions on top of files', plugin: 'fileVersionsPlugin' },
  { name: '@basaltkit/storage', covers: 'disk/object storage (local, S3, Azure, GCS)', plugin: 'storagePlugin' },
  { name: '@basaltkit/drives', covers: 'import from Google Drive, OneDrive/SharePoint, Dropbox', plugin: 'drivesPlugin' },
  { name: '@basaltkit/subscriptions', covers: 'billing: plans, subscriptions, trials, usage limits, payment gateways', plugin: 'subscriptionsPlugin', prisma: '@basaltkit/subscriptions-prisma' },
  { name: '@basaltkit/webhooks', covers: 'outbound webhooks with signing and retries', plugin: 'webhooksPlugin', prisma: '@basaltkit/webhooks-prisma' },
  { name: '@basaltkit/events', covers: 'typed domain events, listeners, transactional outbox', plugin: 'eventsPlugin', prisma: '@basaltkit/events-prisma' },
  { name: '@basaltkit/queue', covers: 'background jobs (BullMQ, RabbitMQ, SQS, Kafka)', plugin: 'queuePlugin' },
  { name: '@basaltkit/scheduler', covers: 'scheduled / recurring tasks (cron-like)', plugin: 'schedulerPlugin' },
  { name: '@basaltkit/mailer', covers: 'sending email (SMTP, Resend, SES, Mailgun)', plugin: 'mailerPlugin' },
  { name: '@basaltkit/inbound-mail', covers: 'receiving email', routes: 'inboundMailRoutes' },
  { name: '@basaltkit/realtime', covers: 'live updates over WebSocket/SSE, presence', plugin: 'realtimePlugin' },
  { name: '@basaltkit/search', covers: 'full-text search (Postgres, Elasticsearch, Meilisearch)', plugin: 'searchPlugin' },
  { name: '@basaltkit/cache', covers: 'caching with tags and tenant scoping', plugin: 'cachePlugin' },
  { name: '@basaltkit/flags', covers: 'feature flags and percentage rollouts', plugin: 'flagsPlugin' },
  { name: '@basaltkit/exports', covers: 'CSV/JSON/XLSX exports and CSV import', plugin: 'exportsPlugin' },
  { name: '@basaltkit/i18n', covers: 'translations, locale, number/date formatting' },
  { name: '@basaltkit/backup', covers: 'PostgreSQL backups', plugin: 'backupPlugin' },
  { name: '@basaltkit/mcp', covers: 'expose routes as MCP tools for AI agents', plugin: 'mcpPlugin' },
]

/** One catalog line per package, for the planner's system prompt. */
export function renderEcosystemCatalog(packages: readonly EcosystemPackage[] = ECOSYSTEM_PACKAGES): string {
  return packages
    .map((p) => {
      const wiring = [p.plugin, p.routes ? `${p.routes}()` : undefined].filter(Boolean).join(' + ')
      const store = p.prisma ? `; Prisma store: ${p.prisma}` : ''
      return `- ${p.name} — ${p.covers}${wiring ? ` (wire: ${wiring}${store})` : store ? ` (${store.slice(2)})` : ''}`
    })
    .join('\n')
}
