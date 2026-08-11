# Pacotes

O Basalt é um conjunto de pacotes pequenos e focados sob o scope `@basaltkit/*`.
Cada um funciona por si só; juntos formam o framework. As versões movem-se em
sincronia (atualmente **0.31.0**, 69 pacotes).

## Fundação

| Pacote | Propósito |
|---|---|
| `@basaltkit/core` | Container de DI, ciclo de vida de plugins, contexto `AsyncLocalStorage`, hooks |
| `@basaltkit/config` | Configuração tipada e por namespace com acesso por dot-path |
| `@basaltkit/env` | Variáveis de ambiente validadas com Zod e um relatório agregado |
| `@basaltkit/events` | Bus de eventos de domínio tipado com wildcards e prioridades; outbox transacional |
| `@basaltkit/events-sqlite` · `@basaltkit/events-prisma` | Backends duráveis para o OutboxStore de `@basaltkit/events` — outbox transacional resistente a crashes; SQLite (zero-dep) e Prisma (Postgres/MySQL) |
| `@basaltkit/logger` | Logger Pino, auto-enriquecido com contexto de pedido/tenant, redação |

## HTTP

| Pacote | Propósito |
|---|---|
| `@basaltkit/http` | Núcleo neutro em relação ao framework — rotas tipadas, pipeline, mapeamento de erros, plugins de periferia |
| `@basaltkit/fastify` · `@basaltkit/express` · `@basaltkit/hono` | Adaptadores — as mesmas rotas correm em qualquer um deles |
| `@basaltkit/sdk` | Cliente type-safe inferido a partir de definições de endpoint em Zod |

## Dados e infraestrutura

| Pacote | Propósito |
|---|---|
| `@basaltkit/prisma` | Extensão de cliente com âmbito de tenant, pool LRU de clientes por tenant, `ctx().db` |
| `@basaltkit/cache` | Drivers Redis/Memory, tags, TTL, proteção contra stampede, chaves por tenant |
| `@basaltkit/cache-tiered` | Driver de cache multi-nível — cache próxima em processo à frente do Redis |
| `@basaltkit/storage` | Local/S3/MinIO sob um contrato, isolamento por tenant, URLs assinados |
| `@basaltkit/storage-gcs` · `@basaltkit/storage-azure` | Drivers para Google Cloud Storage e Azure Blob |
| `@basaltkit/mailer` | Emails declarativos tipados, drivers SMTP/log/memory, remetente por tenant |
| `@basaltkit/scheduler` | Cron fluente: `schedule.job(X).daily().at('03:00')` |

## Filas

| Pacote | Propósito |
|---|---|
| `@basaltkit/queue` | Jobs declarativos, propagação de contexto, driver plugável + verificações de capacidade |
| `@basaltkit/queue-rabbitmq` | Driver RabbitMQ — retries, backoff, delay, prioridade via DLX |
| `@basaltkit/queue-kafka` | Driver Kafka — produzir/consumir com retry + tópicos de dead-letter |
| `@basaltkit/queue-sqs` | Driver Amazon SQS — delay nativo, retries com backoff, DLQ |

## Domínio SaaS

| Pacote | Propósito |
|---|---|
| `@basaltkit/tenancy` | Resolvers, contexto de tenant por pedido, hooks de ciclo de vida |
| `@basaltkit/tenancy-sqlite` · `@basaltkit/tenancy-prisma` | Backends duráveis para o TenantSource de `@basaltkit/tenancy` — persistem o registo de tenants e domínios personalizados; SQLite (zero-dep) e Prisma (Postgres/MySQL) |
| `@basaltkit/auth` | Hashing de palavras-passe, JWT + rotação de refresh, sessões, verificação de email, reposição de palavra-passe, chaves de API, MFA (TOTP) |
| `@basaltkit/auth-sqlite` | Backend SQLite durável (`node:sqlite`) para todos os stores de `@basaltkit/auth` — sobrevive a reinícios, zero deps |
| `@basaltkit/auth-prisma` | Backend Prisma para todos os stores de `@basaltkit/auth` — Postgres/MySQL, traz um schema de referência, passa o teu `PrismaClient` |
| `@basaltkit/permissions` | Papéis, permissões wildcard, políticas, âmbito de tenant, super admin |
| `@basaltkit/permissions-sqlite` · `@basaltkit/permissions-prisma` | Backends duráveis para o AccessStore de `@basaltkit/permissions` — SQLite (zero-dep) e Prisma (Postgres/MySQL) |
| `@basaltkit/teams` | Tenants multi-utilizador — papéis, convites por email, adesão, guard `teamRole` |
| `@basaltkit/teams-sqlite` · `@basaltkit/teams-prisma` | Backends duráveis para os stores de `@basaltkit/teams` — SQLite (`node:sqlite`, zero-dep) e Prisma (Postgres/MySQL) |
| `@basaltkit/subscriptions` | Planos, trials, limites de funcionalidades, drivers de gateway, Checkout e Portal alojados, proporcionalidade |
| `@basaltkit/subscriptions-sqlite` · `@basaltkit/subscriptions-prisma` | Backends duráveis para os stores de subscrição, utilização (`consume` atómico) e webhooks — SQLite (zero-dep) e Prisma (Postgres/MySQL) |
| `@basaltkit/flags` | Feature flags — segmentação por tenant/utilizador, rollouts determinísticos |
| `@basaltkit/webhooks` | Webhooks de saída — entrega assinada, retries, subscrições por tenant |
| `@basaltkit/webhooks-sqlite` · `@basaltkit/webhooks-prisma` | Backends duráveis para o WebhookStore de `@basaltkit/webhooks` — persistem as subscrições de endpoint entre reinícios; SQLite (zero-dep) e Prisma (Postgres/MySQL) |
| `@basaltkit/audit` · `@basaltkit/activity` · `@basaltkit/notifications` | Registo de auditoria, feed de atividade, notificações multicanal |
| `@basaltkit/comments-sqlite` · `@basaltkit/comments-prisma` | Backends duráveis para o CommentStore de `@basaltkit/comments` |
| `@basaltkit/audit-sqlite` · `@basaltkit/audit-prisma` · `@basaltkit/activity-sqlite` · `@basaltkit/activity-prisma` · `@basaltkit/notifications-sqlite` · `@basaltkit/notifications-prisma` | Backends SQLite/Prisma duráveis para os stores de auditoria, atividade e notificações in-app |

## Capacidades

| Pacote | Propósito |
|---|---|
| `@basaltkit/realtime` | Push servidor→cliente (WebSocket/SSE), canais por tenant, presença, ponte de eventos, backplane Redis |
| `@basaltkit/realtime-client` | Cliente de browser zero-dep para `@basaltkit/realtime` — subscrever canais, reconexão automática |
| `@basaltkit/search` | Pesquisa full-text com âmbito de tenant — drivers em memória (dev) e Meilisearch, sincronização automática a partir de eventos |
| `@basaltkit/search-postgres` | Driver full-text PostgreSQL (`tsvector`/`ts_rank`) para `@basaltkit/search` |
| `@basaltkit/files` | Pipeline de upload sobre o storage — validação de tipo/tamanho, quota por tenant, metadados, hooks de scan |
| `@basaltkit/comments` | Threads de comentários por recurso — @mentions, resolver/reabrir, eventos para realtime e notificações |
| `@basaltkit/i18n` | Internacionalização — locale resolvido pelo contexto, catálogos tipados com plurais, formatação Intl |
| `@basaltkit/exports` · `@basaltkit/exports-xlsx` | Exportações de dados tipadas → CSV/TSV/JSON/NDJSON e um formatador XLSX zero-dep |

## UIs autossuficientes

Páginas HTML sem dependências servidas sobre as tuas rotas JSON existentes.

| Pacote | Página |
|---|---|
| `@basaltkit/audit-viewer` | `/audit/view` — navegar o registo de auditoria (filtros, estatísticas) |
| `@basaltkit/api-keys-ui` | `/apikeys/ui` — criar/listar/revogar chaves de API |
| `@basaltkit/teams-ui` | `/team/ui` — convites e membros |
| `@basaltkit/billing-ui` | `/billing/ui` — planos, Checkout, Customer Portal |

## Experiência de desenvolvimento e produto

| Pacote | Propósito |
|---|---|
| `create-basalt` | Scaffolder de projetos |
| `@basaltkit/cli` · `@basaltkit/generator` | O framework de comandos `basalt` e o scaffolding `basalt make` |
| `@basaltkit/testing` | `createTestApp`, fakes de mail/queue, viagem no tempo |
| `@basaltkit/admin` · `@basaltkit/dashboard` · `@basaltkit/admin-react` · `@basaltkit/admin-shadcn` | Motores headless de admin/dashboard + bindings React e shadcn/ui |

## A regra de dependências

Um pacote só pode depender de pacotes numa camada inferior (fundação →
infraestrutura → domínio → capacidades). Pacotes da mesma camada comunicam através
de eventos e contratos do core, nunca por imports diretos — que é porque qualquer
pacote pode ser adotado por si só, e porque os drivers (queue, storage, search,
cache) encaixam atrás de um contrato estável.
