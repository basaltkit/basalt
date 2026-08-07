# Documentação do Machize

O **Machize** é um framework TypeScript para construir aplicações SaaS completas — API, autenticação, multi-tenancy, faturação, filas, emails e painel de administração — a partir de módulos pequenos que encaixam uns nos outros.

Cada módulo tem documentação completa no seu próprio `README.md`, escrita para que consigas usá-lo **mesmo com pouca experiência de programação**: explicação simples do que resolve, exemplo a funcionar em 5 minutos, guia de utilização, referência completa da API e erros comuns.

## Por onde começar

1. **Cria um projeto novo** com o [create-machize](../packages/create-app/README.md):
   ```bash
   npm create machize minha-app
   ```
2. Lê o README do [@machize/core](../packages/core/README.md) para perceber os conceitos base (app, plugins, contexto).
3. Depois segue para os módulos de que precisas, pela tabela abaixo.

## Módulos

### Fundação

| Módulo | O que faz |
| --- | --- |
| [@machize/core](../packages/core/README.md) | A base de tudo: container de dependências, sistema de plugins, ciclo de vida e contexto por pedido. |
| [@machize/config](../packages/config/README.md) | Configuração tipada por namespaces, com acesso por caminho (`app.nome`). |
| [@machize/env](../packages/env/README.md) | Validação das variáveis de ambiente com Zod — falha no arranque com relatório claro. |
| [@machize/events](../packages/events/README.md) | Bus de eventos de domínio tipados com Zod, listeners com prioridade e wildcards. |

### HTTP e rotas

| Módulo | O que faz |
| --- | --- |
| [@machize/http](../packages/http/README.md) | Núcleo HTTP neutro: rotas tipadas, validação, enrichers e guards — partilhado pelos adaptadores. |
| [@machize/fastify](../packages/fastify/README.md) | Adaptador oficial sobre Fastify (o mais usado). |
| [@machize/express](../packages/express/README.md) | O mesmo modelo de rotas, em Express. |
| [@machize/hono](../packages/hono/README.md) | O mesmo modelo de rotas, em Hono (Node, Bun, Deno, edge). |

### Autenticação e acesso

| Módulo | O que faz |
| --- | --- |
| [@machize/auth](../packages/auth/README.md) | Registo, login, JWT com refresh e sessões, rotas `/auth` prontas e proteção de rotas. |
| [@machize/permissions](../packages/permissions/README.md) | Papéis (roles), permissões com wildcards, policies e guards de rota. |
| [@machize/tenancy](../packages/tenancy/README.md) | Multi-tenancy: resolve o tenant por subdomínio, domínio, header ou rota. |
| [@machize/teams](../packages/teams/README.md) | Equipas: tenants com vários utilizadores, papéis e convites por email. |

### Dados

| Módulo | O que faz |
| --- | --- |
| [@machize/prisma](../packages/prisma/README.md) | Integração com Prisma: isolamento automático por tenant e `ctx().db`. |
| [@machize/cache](../packages/cache/README.md) | Cache com drivers Redis e memória, tags, TTL e isolamento por tenant. |
| [@machize/storage](../packages/storage/README.md) | Ficheiros/objetos: MinIO/S3 e disco local, com URLs temporárias assinadas. |
| [@machize/flags](../packages/flags/README.md) | Feature flags com targeting por tenant/utilizador e rollout por percentagem. |

### Negócio

| Módulo | O que faz |
| --- | --- |
| [@machize/subscriptions](../packages/subscriptions/README.md) | Faturação: planos declarativos, trials, limites de uso, gateways e webhooks idempotentes. |
| [@machize/notifications](../packages/notifications/README.md) | Notificações multi-canal (in-app, email, custom) com preferências por destinatário. |
| [@machize/mailer](../packages/mailer/README.md) | Emails tipados e declarativos, drivers SMTP/log/memória e integração com filas. |
| [@machize/webhooks](../packages/webhooks/README.md) | Webhooks de saída assinados, com retries e subscrições por tenant. |

### Operações

| Módulo | O que faz |
| --- | --- |
| [@machize/queue](../packages/queue/README.md) | Filas sobre BullMQ: jobs declarativos com payloads Zod e driver síncrono para testes. |
| [@machize/scheduler](../packages/scheduler/README.md) | Agendamento fluente: `schedule.job(X).daily().at('03:00')`, timezones e sem sobreposição. |
| [@machize/logger](../packages/logger/README.md) | Logs estruturados (Pino) com requestId/tenantId automáticos e campos sensíveis ocultados. |
| [@machize/audit](../packages/audit/README.md) | Trilho de auditoria append-only, alimentado por hooks e eventos de domínio. |
| [@machize/activity](../packages/activity/README.md) | Registo de atividade visível ao utilizador (estilo Spatie Activitylog), com feeds consultáveis. |

### Painel de administração e frontend

| Módulo | O que faz |
| --- | --- |
| [@machize/admin](../packages/admin/README.md) | Kit de admin headless: colunas de tabelas, formulários e validação derivados de schemas Zod. |
| [@machize/admin-react](../packages/admin-react/README.md) | Binding React do admin: `DataTable` e `ResourceForm` + hooks de dados. |
| [@machize/admin-shadcn](../packages/admin-shadcn/README.md) | Componentes com estilo shadcn/ui para o admin. |
| [@machize/dashboard](../packages/dashboard/README.md) | Modelo de dashboard: métricas de faturação (MRR/ARR/churn), resumos de filas/auditoria. |
| [@machize/sdk](../packages/sdk/README.md) | Cliente HTTP type-safe para o frontend, com refresh de token transparente. |

### Ferramentas de desenvolvimento

| Módulo | O que faz |
| --- | --- |
| [create-machize](../packages/create-app/README.md) | Cria um projeto novo completo: `npm create machize minha-app`. |
| [@machize/cli](../packages/cli/README.md) | O comando `mach`: define e corre comandos contra a app. |
| [@machize/generator](../packages/generator/README.md) | Geradores de código (`mach make`): cria um recurso completo (schema → rotas → teste). |
| [@machize/testing](../packages/testing/README.md) | Kit de testes: `createTestApp`, impersonação de utilizador/tenant, fakes de mail/filas e time travel. |

## Convenções comuns a todos os módulos

- **Instalação**: `pnpm add @machize/<nome>` (os projetos Machize usam pnpm).
- **Plugins**: quase todos os módulos se ligam à app com `app.use(<nome>Plugin(...))` do `@machize/core`.
- **Zod em todo o lado**: schemas Zod definem validação, tipos e documentação ao mesmo tempo.
- **Contexto por pedido**: `ctx()` dá acesso a tenant, utilizador, logger e base de dados em qualquer ponto do código.
