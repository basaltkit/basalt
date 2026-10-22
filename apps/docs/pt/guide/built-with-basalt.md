# Construído com Basalt

O Basalt nasceu de produtos reais, e não o contrário. Hoje correm sobre ele
quatro aplicações de quatro domínios diferentes. Cada uma encontrou lacunas que
voltaram ao framework como correções e pacotes novos.

| App | Domínio | Tenancy | Pacotes Basalt |
| --- | --- | --- | --- |
| [Mukanda](#mukanda) | Gestão documental e digitalização de processos | Central + um schema PostgreSQL por empresa | 43 |
| [Corredor](#corredor) | Logística B2B | Central + um schema PostgreSQL por tenant | 28 |
| [lexfirma](#lexfirma) | Gestão de escritórios de advogados | Um schema PostgreSQL por escritório | 47 |
| [producer-basalt](#producer-basalt) | Backend de uma app móvel agrícola | Um só tenant, MySQL | 21 |

A contagem inclui o frontend web de cada app (`web/`) e as ferramentas só de
desenvolvimento (`generator`, `testing`, `ai-mcp`, `deploy`).

[[toc]]

## Mukanda {#mukanda}

Gestão documental e digitalização de processos para empresas. Um schema central
guarda as empresas, os planos e a equipa do operador; cada empresa tem o seu
próprio schema PostgreSQL, com o seu próprio cliente Prisma — o padrão dos
[dois planos](/pt/guide/multi-tenant-pattern).

- **Documentos:** `files` com `files-prisma`, storage S3 e os
  [drives](/pt/guide/drives) na nuvem (Dropbox, Google Drive, OneDrive).
- **O trabalho à volta deles:** `notifications`, `webhooks`, `realtime`,
  [exportação](/pt/guide/exports) para folha de cálculo, e `audit` com o seu
  visualizador.
- **Trabalho em segundo plano:** [filas](/pt/guide/queues) BullMQ e o
  [agendador](/pt/guide/scheduler).
- **Faturação e acesso:** `subscriptions`, `teams`, `permissions`, `auth`.
- **Operação:** um servidor [MCP](/pt/guide/mcp), e deploys com
  [`@basaltkit/deploy`](/pt/guide/deploy).

O Mukanda foi a app que mais puxou pelo Basalt. Manteve uma lista escrita de
cada lacuna do framework que encontrou (BK-025 a BK-087), e a lista inteira saiu
em versões do framework no [Basalt 1.13](/pt/guide/whats-new).

## Corredor {#corredor}

Uma plataforma de logística B2B. Acompanha o fluxo inteiro — pedido, carga,
transportadora, viatura, motorista, operação, entrega, comprovativo — com
atualizações em tempo real por tenant, via Server-Sent Events.

- **Tenancy:** uma base de dados central (o registo de tenants, as subscrições,
  os contadores) e um schema PostgreSQL por tenant, com dois clientes Prisma.
- **Tempo real:** [realtime](/pt/guide/realtime), um stream por tenant.
- **Integração:** `webhooks`, `events`, `audit`, storage S3 e um servidor
  [MCP](/pt/guide/mcp).
- **Faturação:** `subscriptions` com Prisma.

## lexfirma {#lexfirma}

Gestão de escritórios de advogados em Angola: contactos, clientes, casos,
prazos, audiências, documentos, comunicações, honorários e faturação, e um
portal onde os clientes acompanham os seus próprios processos.

- **Isolamento:** cada escritório é um tenant com o seu próprio schema
  PostgreSQL, e não uma coluna a separar linhas.
- **Pagamentos:** [pagamentos por referência](/pt/guide/reference-payments) via
  ProxyPay, por cima de `subscriptions`.
- **Encontrar as coisas:** [pesquisa](/pt/guide/search) full-text em PostgreSQL.
- **Responsabilização:** `activity`, `audit`, `notifications` e
  [backups](/pt/guide/backup) PostgreSQL.
- **Frontend:** a consola de administração é feita com `admin`, `admin-react` e
  `admin-shadcn`, com `dashboard`, `realtime-client` e o
  [SDK](/pt/guide/web-ui) tipado.

## producer-basalt {#producer-basalt}

O backend de uma app móvel agrícola, reconstruído em Basalt. O backend antigo
tinha um framework próprio feito à mão. A reconstrução substituiu-o por
completo, mantendo byte a byte o algoritmo de sincronização offline da app móvel
(WatermelonDB) e o mesmo contrato de API `/v1`. A app móvel não teve de mudar.

- **HTTP:** `createApp` com os plugins de segurança, métricas e OpenAPI, sobre
  Fastify.
- **Dados:** o schema MySQL existente, através de `prisma`, sem alterações.
- **Auth:** `auth` sobre a tabela de utilizadores existente, compatível com os
  hashes de palavra-passe antigos e com as rotas `/v1/auth` antigas.
- **Uploads:** `storage` num storage compatível com S3.
- **Trabalho em segundo plano:** [filas](/pt/guide/queues) em BullMQ e RabbitMQ.
- **Ferramentas de IA:** um servidor [MCP](/pt/guide/mcp) com ferramentas de
  dados limitadas por papel e auditadas.

Mostra um caminho que as outras três não mostram: trazer um backend que já está
em produção para o Basalt sem partir os clientes que dependem dele.

## O que têm em comum

- **Os mesmos blocos, produtos muito diferentes.** `core`, `http`, `auth`,
  `prisma` e `fastify` estão nas quatro. Tudo o resto é escolhido por app.
- **Código de domínio na app, código transversal no framework.** Quando uma app
  precisou de algo genérico, isso entrou no Basalt como pacote ou correção, e não
  como um remendo local.
- **Um só caminho de deploy.** Três das quatro fazem deploy com
  `@basaltkit/deploy` para um servidor Linux simples.

## Ver também

- [Basalt vs outras frameworks](/pt/guide/comparison) — onde o Basalt encaixa, e
  onde as outras são mais fortes.
- [Construir um SaaS de notas](/pt/cookbook/notes-saas) — o mesmo percurso que
  estas apps fizeram, de uma pasta vazia até um servidor.
