# Documentação do Basalt

O **Basalt** é um framework TypeScript para construir aplicações SaaS completas — API, autenticação, multi-tenancy, faturação, filas, emails e painel de administração — a partir de módulos pequenos que encaixam uns nos outros.

Cada módulo tem documentação completa no seu próprio `README.md`, escrita para que consigas usá-lo **mesmo com pouca experiência de programação**: explicação simples do que resolve, exemplo a funcionar em 5 minutos, guia de utilização, referência completa da API e erros comuns.

## Por onde começar

1. **Cria um projeto novo** com o [create-basalt](../packages/create-app/README.md):
   ```bash
   npm create basalt minha-app
   ```
2. Lê o README do [@basaltkit/core](../packages/core/README.md) para perceber os conceitos base (app, plugins, contexto).
3. Depois segue para os módulos de que precisas, pela tabela abaixo.

## Módulos

### Fundação

| Módulo | O que faz |
| --- | --- |
| [@basaltkit/core](../packages/core/README.md) | A base de tudo: container de dependências, sistema de plugins, ciclo de vida e contexto por pedido. |
| [@basaltkit/config](../packages/config/README.md) | Configuração tipada por namespaces, com acesso por caminho (`app.nome`). |
| [@basaltkit/env](../packages/env/README.md) | Validação das variáveis de ambiente com Zod — falha no arranque com relatório claro. |
| [@basaltkit/events](../packages/events/README.md) | Bus de eventos de domínio tipados com Zod, listeners com prioridade e wildcards. |

### HTTP e rotas

| Módulo | O que faz |
| --- | --- |
| [@basaltkit/http](../packages/http/README.md) | Núcleo HTTP neutro: rotas tipadas, validação, enrichers e guards — partilhado pelos adaptadores. |
| [@basaltkit/fastify](../packages/fastify/README.md) | Adaptador oficial sobre Fastify (o mais usado). |
| [@basaltkit/express](../packages/express/README.md) | O mesmo modelo de rotas, em Express. |
| [@basaltkit/hono](../packages/hono/README.md) | O mesmo modelo de rotas, em Hono (Node, Bun, Deno, edge). |

### Autenticação e acesso

| Módulo | O que faz |
| --- | --- |
| [@basaltkit/auth](../packages/auth/README.md) | Registo, login, JWT com refresh e sessões, rotas `/auth` prontas e proteção de rotas. |
| [@basaltkit/permissions](../packages/permissions/README.md) | Papéis (roles), permissões com wildcards, policies e guards de rota. |
| [@basaltkit/tenancy](../packages/tenancy/README.md) | Multi-tenancy: resolve o tenant por subdomínio, domínio, header ou rota. |
| [@basaltkit/teams](../packages/teams/README.md) | Equipas: tenants com vários utilizadores, papéis e convites por email. |

### Dados

| Módulo | O que faz |
| --- | --- |
| [@basaltkit/prisma](../packages/prisma/README.md) | Integração com Prisma: isolamento automático por tenant e `ctx().db`. |
| [@basaltkit/cache](../packages/cache/README.md) | Cache com drivers Redis e memória, tags, TTL e isolamento por tenant. |
| [@basaltkit/storage](../packages/storage/README.md) | Ficheiros/objetos: MinIO/S3 e disco local, com URLs temporárias assinadas. |
| [@basaltkit/flags](../packages/flags/README.md) | Feature flags com targeting por tenant/utilizador e rollout por percentagem. |

### Negócio

| Módulo | O que faz |
| --- | --- |
| [@basaltkit/subscriptions](../packages/subscriptions/README.md) | Faturação: planos declarativos, trials, limites de uso, gateways e webhooks idempotentes. |
| [@basaltkit/notifications](../packages/notifications/README.md) | Notificações multi-canal (in-app, email, custom) com preferências por destinatário. |
| [@basaltkit/mailer](../packages/mailer/README.md) | Emails tipados e declarativos, drivers SMTP/log/memória e integração com filas. |
| [@basaltkit/webhooks](../packages/webhooks/README.md) | Webhooks de saída assinados, com retries e subscrições por tenant. |

### Operações

| Módulo | O que faz |
| --- | --- |
| [@basaltkit/queue](../packages/queue/README.md) | Filas sobre BullMQ: jobs declarativos com payloads Zod e driver síncrono para testes. |
| [@basaltkit/scheduler](../packages/scheduler/README.md) | Agendamento fluente: `schedule.job(X).daily().at('03:00')`, timezones e sem sobreposição. |
| [@basaltkit/logger](../packages/logger/README.md) | Logs estruturados (Pino) com requestId/tenantId automáticos e campos sensíveis ocultados. |
| [@basaltkit/audit](../packages/audit/README.md) | Trilho de auditoria append-only, alimentado por hooks e eventos de domínio. |
| [@basaltkit/activity](../packages/activity/README.md) | Registo de atividade visível ao utilizador (estilo Spatie Activitylog), com feeds consultáveis. |

### Painel de administração e frontend

| Módulo | O que faz |
| --- | --- |
| [@basaltkit/admin](../packages/admin/README.md) | Kit de admin headless: colunas de tabelas, formulários e validação derivados de schemas Zod. |
| [@basaltkit/admin-react](../packages/admin-react/README.md) | Binding React do admin: `DataTable` e `ResourceForm` + hooks de dados. |
| [@basaltkit/admin-shadcn](../packages/admin-shadcn/README.md) | Componentes com estilo shadcn/ui para o admin. |
| [@basaltkit/dashboard](../packages/dashboard/README.md) | Modelo de dashboard: métricas de faturação (MRR/ARR/churn), resumos de filas/auditoria. |
| [@basaltkit/sdk](../packages/sdk/README.md) | Cliente HTTP type-safe para o frontend, com refresh de token transparente. |

### Ferramentas de desenvolvimento

| Módulo | O que faz |
| --- | --- |
| [create-basalt](../packages/create-app/README.md) | Cria um projeto novo completo: `npm create basalt minha-app`. |
| [@basaltkit/cli](../packages/cli/README.md) | O comando `basalt`: define e corre comandos contra a app. |
| [@basaltkit/generator](../packages/generator/README.md) | Geradores de código (`basalt make`): cria um recurso completo (schema → rotas → teste). |
| [@basaltkit/testing](../packages/testing/README.md) | Kit de testes: `createTestApp`, impersonação de utilizador/tenant, fakes de mail/filas e time travel. |

## Convenções comuns a todos os módulos

- **Instalação**: `pnpm add @basaltkit/<nome>` (os projetos Basalt usam pnpm).
- **Plugins**: quase todos os módulos se ligam à app com `app.use(<nome>Plugin(...))` do `@basaltkit/core`.
- **Zod em todo o lado**: schemas Zod definem validação, tipos e documentação ao mesmo tempo.
- **Contexto por pedido**: `ctx()` dá acesso a tenant, utilizador, logger e base de dados em qualquer ponto do código.
