# Instalação

## Scaffold de uma nova app

A forma mais rápida de começar é o scaffolder de projeto, `create-basalt`. Gera
uma app com forma de produção e inclui apenas o que escolheres — nada de código
morto é enviado. O comando `create` do teu gestor de pacotes descarrega-o e
corre-o na hora — nada para instalar primeiro:

```bash
pnpm create basalt my-saas
# ou
npm create basalt my-saas
# ou
yarn create basalt my-saas
# ou
bun create basalt my-saas
```

Corre-o **sem um nome** num terminal para responderes às perguntas
interativamente (multi-tenancy, auth, faturação, web UI, CLI, instalação, git).
Passa flags para saltar as perguntas:

| Flag | Default | O que faz |
| --- | --- | --- |
| `--no-tenancy` | tenancy **ativa** | Salta multi-tenancy (`@basaltkit/tenancy`) |
| `--no-auth` | auth **ativa** | Salta autenticação (`@basaltkit/auth`, `APP_SECRET`, `/auth/*`) |
| `--billing` | desativado | Inclui subscrições/planos (`@basaltkit/subscriptions`) |
| `--ui` | desativado | Adiciona um frontend `web/` React + shadcn — vê [Web UI](/guide/web-ui). Força pnpm |
| `--cli` | desativado | Adiciona a CLI `basalt` (geradores `make:*` + comandos embutidos) |
| `--install` | desativado | Instala dependências no fim |
| `--git` | desativado | `git init` + um commit inicial |
| `--pm=<mgr>` | autodeteção | Força `pnpm` \| `npm` \| `yarn` \| `bun` |
| `--dir=<path>` | `./<name>` | Pasta de destino |
| `-y`, `--yes` | — | Aceita todos os defaults, sem perguntas |

```bash
pnpm create basalt my-saas --billing --cli --install --git   # stack completa, instalada e commitada
npm create basalt service-api --no-tenancy --no-auth         # API mínima
```

Por defeito o scaffolder apenas escreve ficheiros — não instala dependências nem
mexe no git a menos que adiciones `--install` / `--git`. Por isso os passos
seguintes habituais são:

```bash
cd my-saas
pnpm install
pnpm dev        # http://localhost:3000  (health check em /health)
pnpm test
```

O projeto gerado arranca uma app com rotas tipadas, logging estruturado, um
health check e — a menos que tenhas desativado — multi-tenancy (resolvers de
header e subdomínio) e autenticação. Para uma execução guiada ponta-a-ponta, vê
[Começar](/pt/guide/getting-started).

::: warning Aviso: `--ui` requer pnpm
O frontend `web/` é membro de um workspace pnpm (`pnpm-workspace.yaml`), que o
npm, yarn e bun não conseguem instalar nem correr. Se pedires `--ui` com outro
gestor, o scaffolder muda automaticamente para pnpm.
:::

## Escolher um adaptador HTTP

As tuas rotas são escritas uma vez e correm em qualquer um de três adaptadores —
escolhe o adequado à tua stack (vê [Adaptadores HTTP](/pt/guide/adapters)):

```bash
pnpm add @basaltkit/core @basaltkit/http @basaltkit/fastify fastify          # Fastify
pnpm add @basaltkit/core @basaltkit/http @basaltkit/express express          # Express
pnpm add @basaltkit/core @basaltkit/http @basaltkit/hono hono @hono/node-server  # Hono
```

## Adicionar a uma app existente

Os pacotes do Basalt funcionam incrementalmente. Para adicionar multi-tenancy a
uma app existente, instala apenas as peças de que precisas — funciona da mesma
forma em qualquer adaptador:

```bash
pnpm add @basaltkit/core @basaltkit/tenancy
```

Cada pacote publica ESM com tipos e segue o mesmo contrato de plugin, por isso
adotas uma capacidade de cada vez.

## Requisitos

- **Node.js 22+**
- **pnpm** (recomendado) — o monorepo fixa a sua versão via `packageManager`
- Para produção: **PostgreSQL** (Prisma), e **Redis** para cache/filas quando as
  ativares

## Scaffold dentro de um projeto

Assim que tiveres uma app, gera verticais de recurso completas com o gerador da
CLI:

```bash
basalt make:resource Project
```

Isto emite um schema, repositório, serviço, plugin de DI, rotas CRUD tipadas e um
teste — tudo ligado e pronto a correr.
