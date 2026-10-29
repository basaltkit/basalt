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
  /**
   * The wiring as the package README shows it, one line — so a plan names the
   * real options instead of guessing them (it once wrote
   * `app.register(mailerPlugin, { provider: 'smtp' })`).
   */
  example?: string
  /** The same wiring with the Prisma store, for apps on Prisma. */
  prismaExample?: string
  /** The DI token a service resolves with `ctx().container.get(TOKEN)`. */
  token?: string
}

export const ECOSYSTEM_PACKAGES: readonly EcosystemPackage[] = [
  {
    name: '@basaltkit/auth', covers: 'login, signup, JWT/sessions, password reset, MFA, OAuth, passkeys, API keys',
    plugin: 'authPlugin', routes: 'authRoutes', prisma: '@basaltkit/auth-prisma', token: 'AUTH',
    example: 'authPlugin({ users: new MemoryUserSource(), secret: env.AUTH_SECRET }) + fastifyPlugin({ routes: [...authRoutes()] })',
    prismaExample: 'const s = prismaAuthStores(prisma); authPlugin({ secret: env.AUTH_SECRET, users: s.users, sessions: s.sessions, refreshTokens: s.refreshTokens, tokens: s.tokens, mfa: s.mfa })',
  },
  {
    name: '@basaltkit/permissions', covers: 'roles, permissions, policies, route guards (RBAC)',
    plugin: 'permissionsPlugin', prisma: '@basaltkit/permissions-prisma', token: 'GATE',
    example: 'permissionsPlugin({ store })',
    prismaExample: 'const p = prismaAccessStore(prisma); permissionsPlugin({ store: p.store })',
  },
  {
    name: '@basaltkit/tenancy', covers: 'multi-tenancy: tenant resolution and tenant context',
    plugin: 'tenancyPlugin', prisma: '@basaltkit/tenancy-prisma', token: 'TENANCY',
    example: 'tenancyPlugin({ source, resolvers: [headerResolver()] })',
    prismaExample: 'tenancyPlugin({ source: prismaTenantSource(prisma), resolvers: [subdomainResolver({ base: env.APP_DOMAIN })] })',
  },
  {
    name: '@basaltkit/teams', covers: 'team members, roles inside a tenant, email invitations',
    plugin: 'teamsPlugin', routes: 'teamRoutes', prisma: '@basaltkit/teams-prisma', token: 'TEAMS',
    example: 'teamsPlugin() + fastifyPlugin({ routes: [...teamRoutes()] })',
    prismaExample: 'const t = prismaTeamsStores(prisma); teamsPlugin({ memberships: t.memberships, invitations: t.invitations })',
  },
  {
    name: '@basaltkit/comments', covers: 'comment threads on any resource, @mentions, resolve/reopen',
    plugin: 'commentsPlugin', routes: 'commentRoutes', prisma: '@basaltkit/comments-prisma', token: 'COMMENTS',
    example: 'commentsPlugin() + fastifyPlugin({ routes: [...commentRoutes()] })',
    prismaExample: 'commentsPlugin({ store: prismaCommentsStore(prisma).store })',
  },
  {
    name: '@basaltkit/activity', covers: 'user-facing activity feed / history of changes',
    plugin: 'activityPlugin', prisma: '@basaltkit/activity-prisma', token: 'ACTIVITY',
    example: "activityPlugin(); then container.get(ACTIVITY).in('project').performedOn('project', id).log('published')",
    prismaExample: 'activityPlugin({ store: prismaActivityStore(prisma).store })',
  },
  {
    name: '@basaltkit/audit', covers: 'append-only audit trail of state changes',
    plugin: 'auditPlugin', prisma: '@basaltkit/audit-prisma', token: 'AUDIT',
    example: 'eventsPlugin() + auditPlugin()',
    prismaExample: 'auditPlugin({ store: prismaAuditStore(prisma).store })',
  },
  {
    name: '@basaltkit/notifications', covers: 'in-app and email notifications, per-user preferences',
    plugin: 'notificationsPlugin', routes: 'inAppRoutes', prisma: '@basaltkit/notifications-prisma', token: 'NOTIFIER',
    example: 'mailerPlugin({ driver: \'log\', from: env.MAIL_FROM }) + notificationsPlugin()',
    prismaExample: 'notificationsPlugin({ inApp: prismaInAppStore(prisma).store, preferences: prismaPreferenceStore(prisma) })',
  },
  {
    name: '@basaltkit/files', covers: 'file uploads and attachments, quotas, signed URLs',
    plugin: 'filesPlugin', routes: 'fileRoutes', prisma: '@basaltkit/files-prisma', token: 'FILES',
    example: "storagePlugin({ disks: { uploads: { driver: 'local', root: './storage' } } }) + filesPlugin({ disk: 'uploads', validate: { maxSize: 5_000_000 } }) + fastifyPlugin({ routes: [...fileRoutes()] })",
    prismaExample: "filesPlugin({ disk: 'uploads', store: prismaFilesStore(prisma).store })",
  },
  {
    name: '@basaltkit/files-versions', covers: 'document versions / revisions on top of files',
    plugin: 'fileVersionsPlugin', token: 'FILE_VERSIONS',
    example: 'fileVersionsPlugin({ store: prismaFileVersionsStore(prisma).store })  // store from @basaltkit/files-prisma/versions',
  },
  {
    name: '@basaltkit/storage', covers: 'disk/object storage (local, S3, Azure, GCS)',
    plugin: 'storagePlugin', token: 'STORAGE',
    example: "storagePlugin({ default: 'uploads', disks: { uploads: { driver: 'local', root: './storage' } } })",
  },
  {
    name: '@basaltkit/drives', covers: 'import from Google Drive, OneDrive/SharePoint, Dropbox',
    plugin: 'drivesPlugin', token: 'DRIVES',
    example: "drivesPlugin({ providers: [dropboxDrive({ clientId, clientSecret })], keys: [{ id: '2026-09', key: env.DRIVES_ENCRYPTION_KEY }], secret: env.APP_SECRET })",
  },
  {
    name: '@basaltkit/subscriptions', covers: 'billing: plans, subscriptions, trials, usage limits, payment gateways',
    plugin: 'subscriptionsPlugin', prisma: '@basaltkit/subscriptions-prisma', token: 'SUBSCRIPTIONS',
    example: "subscriptionsPlugin({ plans, fallbackPlan: 'free', gateway }) + routes billingRoutes({ successUrl, cancelUrl }), invoiceRoutes(); guard with meta: { subscribed: 'pro' } / { feature: 'api' }",
    prismaExample: 'const s = prismaSubscriptionsStores(prisma); subscriptionsPlugin({ plans, store: s.store, usage: s.usage, webhooks: s.webhooks })',
  },
  {
    name: '@basaltkit/webhooks', covers: 'outbound webhooks with signing and retries',
    plugin: 'webhooksPlugin', prisma: '@basaltkit/webhooks-prisma', token: 'WEBHOOKS',
    example: "eventsPlugin() + webhooksPlugin({ secret: env.WEBHOOK_SECRET, events: ['invoice.*'] })",
    prismaExample: 'webhooksPlugin({ store: prismaWebhookStore(prisma).store, secret: env.WEBHOOK_SECRET })',
  },
  {
    name: '@basaltkit/events', covers: 'typed domain events, listeners, transactional outbox',
    plugin: 'eventsPlugin', prisma: '@basaltkit/events-prisma', token: 'EVENTS',
    example: "eventsPlugin() + outboxPlugin({ store, captureEvents: ['invoice.*'], dispatch: async (entry) => { … } })",
    prismaExample: 'outboxPlugin({ store: prismaOutboxStore(prisma, { claim: true }).store, dispatch })',
  },
  {
    name: '@basaltkit/queue', covers: 'background jobs (BullMQ, RabbitMQ, SQS, Kafka)',
    plugin: 'queuePlugin', token: 'QUEUE',
    example: 'queuePlugin({ jobs: [SendWelcomeEmail] })  // no connection = sync driver; bullmqQueuePlugin({ jobs, connection: env.REDIS_URL }) from @basaltkit/queue-bullmq',
  },
  {
    name: '@basaltkit/scheduler', covers: 'scheduled / recurring tasks (cron-like)',
    plugin: 'schedulerPlugin', token: 'SCHEDULER',
    example: "schedulerPlugin({ define: (schedule) => { schedule.call('backup', async () => { … }).daily().at('03:00') } })",
  },
  {
    name: '@basaltkit/mailer', covers: 'sending email (SMTP, Resend, SES, Mailgun)',
    plugin: 'mailerPlugin', token: 'MAILER',
    example: "mailerPlugin({ driver: 'log', from: env.MAIL_FROM })  // or driver: 'resend', resend: { apiKey }; SMTP: driver: smtpMailer({ url }) from @basaltkit/mailer-smtp; send with container.get(MAILER)",
  },
  {
    name: '@basaltkit/inbound-mail', covers: 'receiving email',
    routes: 'inboundMailRoutes',
    example: "fastifyPlugin({ routes: [...inboundMailRoutes({ driver: signedDriver({ secret: env.INBOUND_SECRET }), routes: [{ address: '{tenant}@in.example.com', handler }] })] })",
  },
  {
    name: '@basaltkit/realtime', covers: 'live updates over WebSocket/SSE, presence',
    plugin: 'realtimePlugin', token: 'REALTIME',
    example: "realtimePlugin({ bridge: [bridgeRule({ hook: 'note:created', channel: 'notes', event: 'created' })] })",
  },
  {
    name: '@basaltkit/search', covers: 'full-text search (Postgres, Elasticsearch, Meilisearch)',
    plugin: 'searchPlugin', token: 'SEARCH',
    example: "searchPlugin({ indexes: [defineIndex({ name: 'notes', fields: ['title', 'body'] })] })",
  },
  {
    name: '@basaltkit/cache', covers: 'caching with tags and tenant scoping',
    plugin: 'cachePlugin', token: 'CACHE',
    example: "cachePlugin({ driver: 'memory' })  // shared: driver: redisCache(env.REDIS_URL) from @basaltkit/cache-redis",
  },
  {
    name: '@basaltkit/flags', covers: 'feature flags and percentage rollouts',
    plugin: 'flagsPlugin', token: 'FLAGS',
    example: 'flagsPlugin(defineFlags({ newDashboard: { default: false, tenants: { acme: true } }, betaSearch: { default: false, rollout: 25 } }))',
  },
  {
    name: '@basaltkit/exports', covers: 'CSV/JSON/XLSX exports and CSV import',
    plugin: 'exportsPlugin', token: 'EXPORTS',
    example: "exportsPlugin({ formatters: [createCsvFormatter({ delimiter: ';' })] })",
  },
  {
    name: '@basaltkit/i18n', covers: 'translations, locale, number/date formatting',
    plugin: 'i18nPlugin', token: 'I18N',
    example: "i18nPlugin({ locales: { en, pt }, defaultLocale: 'en' })",
  },
  {
    name: '@basaltkit/backup', covers: 'PostgreSQL backups',
    plugin: 'backupPlugin', token: 'BACKUP',
    example: "storagePlugin({ disks: { backups: { driver: 'local', root: './backups', scope: null } } }) + backupPlugin({ connectionUrl: env.DATABASE_URL, disk: 'backups', retention: 7 })",
  },
  {
    name: '@basaltkit/mcp', covers: 'expose routes as MCP tools for AI agents',
    plugin: 'mcpPlugin', token: 'MCP',
    example: "mcpPlugin({ routes, serverInfo: { name: 'app', version: '1.0.0' } }) + fastifyPlugin({ routes: [...routes, ...mcpRoutes()] }); opt a route in with meta: { mcp: { name } }",
  },
]

/** The catalog for the planner's system prompt: one entry per package, wiring indented under it. */
export function renderEcosystemCatalog(packages: readonly EcosystemPackage[] = ECOSYSTEM_PACKAGES): string {
  return packages
    .map((p) => {
      const lines = [`- ${p.name} — ${p.covers}`]
      if (p.example) lines.push(`    wire: ${p.example}`)
      if (p.prismaExample) lines.push(`    with Prisma (${p.prisma}): ${p.prismaExample}`)
      else if (p.prisma) lines.push(`    Prisma store: ${p.prisma}`)
      if (p.token) lines.push(`    use: ctx().container.get(${p.token})`)
      return lines.join('\n')
    })
    .join('\n')
}
