# Desenvolvimento assistido por IA

O `@basaltkit/ai` é uma ferramenta de **desenvolvimento**: um CLI `basalt ai` que
entende o teu projeto Basalt e ajuda a analisar, diagnosticar, planear e gerar
funcionalidades — sempre pelas convenções do próprio framework.

::: tip A IA gera código; o framework define a arquitetura.
O `@basaltkit/ai` **nunca é uma dependência de runtime**. O teu SaaS corre
completamente sem ele, e o código gerado importa os packages oficiais (Prisma,
tenancy, permissões, audit…) — nunca o `@basaltkit/ai`. É uma ferramenta que *usa*
a arquitetura, não inventa uma.
:::

[[toc]]

## Instalação (só dev)

O `create-basalt --cli` já liga isto por ti. Para o adicionar a um app existente,
instala-o como **devDependency**:

```bash
pnpm add -D @basaltkit/ai
```

Regista os comandos no `bin/basalt.ts` (a entrada do CLI) — **não** no `app.ts` —
para que o servidor de runtime nunca importe as ferramentas de dev:

```ts
// bin/basalt.ts
import { runCli } from '@basaltkit/cli'
import { generatorCommands } from '@basaltkit/generator'
import { aiCommands } from '@basaltkit/ai'
import { prismaSyncCommand } from '@basaltkit/prisma'
import { buildApp } from '../src/app.js'

// buildApp recebe os comandos de dev só aqui; o src/server.ts omite-os.
const app = buildApp({ commands: [...generatorCommands(), ...aiCommands(), prismaSyncCommand()] })
process.exit(await runCli({ app }))
```

## Escolher um provider

A IA é agnóstica ao fornecedor (`AI_PROVIDER`). Os comandos read-only
(`ai:analyze`, `ai:doctor`, `ai:fix`) correm offline sem provider; o `ai:plan`, o
`ai:make` e o `--review` chamam um modelo.

```bash
# Anthropic (default)
export AI_PROVIDER=anthropic AI_API_KEY=sk-…

# Qualquer gateway compatível com OpenAI (OpenAI, LiteLLM, OpenRouter, go4ai, …)
export AI_PROVIDER=openai AI_BASE_URL=https://o-teu-gateway/v1 AI_API_KEY=… AI_MODEL=…

# Ollama local (sem chave)
export AI_PROVIDER=ollama AI_MODEL=llama3.1
```

## Comandos

| Comando | O que faz | Modelo? |
| --- | --- | --- |
| `basalt ai` | Visão geral: stack detetado + comandos disponíveis | não |
| `basalt ai:analyze` | Relatório de stack, modelo de dados e diagnósticos | não |
| `basalt ai:doctor` | Diagnósticos com correções sugeridas (sai ≠ 0 em erros) | não |
| `basalt ai:fix [id]` | Aplica uma correção do doctor (ou todas as auto-fixáveis) | não |
| `basalt ai:plan "…"` | Linguagem natural → plano de arquitetura | sim |
| `basalt ai:make "…"` | Planeia **e** implementa uma funcionalidade | sim |

### `ai:analyze` — entender o projeto

Read-only. Deteta o stack wired (Fastify, Prisma, tenancy, auth, RBAC,
subscrições, filas, search…), o modelo de dados Prisma com tenant-scoping, e um
resumo de diagnósticos.

### `ai:doctor` / `ai:fix` — diagnosticar e corrigir

O `ai:doctor` corre um motor de regras offline — `APP_SECRET` inseguro, base de
dados não validada no arranque, logger do Fastify desligado, modelos tenant-scoped
sem `tenantId`, fontes em memória não-duráveis, um Redis a apontar para localhost.
Sai com código ≠ 0 num erro, para poderes usar em CI.

O `ai:fix <id>` aplica a correção de uma regra (ou `ai:fix` para todas as
auto-fixáveis) com um diff linha-a-linha e confirmação. Usa `--dry-run` para
pré-visualizar.

### `ai:plan` — desenhar primeiro

Transforma uma descrição num **plano de arquitetura** numerado (read-only, não
escreve nada). É fundamentado no teu stack real e reutiliza os blocos oficiais:
`make:resource`, scoping por `tenantId`, permissões RBAC e eventos de audit.

### `ai:make` — implementar

Planeia e depois gera um vertical de backend completo, on-convention.

```bash
basalt ai:make "um módulo de faturas por tenant: número, valor, data de emissão e estado (pago/pendente), ligado a um cliente"
```

| Flag | Efeito |
| --- | --- |
| `--dry-run` | Gera em memória, não escreve nada (ótimo com `--review`) |
| `--yes` | Salta a confirmação |
| `--migrate` / `--no-migrate` | Corre `prisma db push` depois de gerar (ou salta) |
| `--review` | Um **Review agent** LLM critica o código gerado |
| `--verify` | Corre o typecheck do projeto |

## O que o `ai:make` gera

Um vertical de backend completo por entidade — tudo pelas APIs oficiais:

- **Model Prisma** — `tenantId` + `@@index` quando tenant-scoped, relações reais
  (coluna FK + `@relation` + o campo inverso), colunas `String` com enum.
- **Schema Zod** — campos tipados, `z.enum([...])` para conjuntos fixos de valores,
  `z.coerce.date()` para datas.
- **Rotas tipadas** — guards RBAC `meta.can` e `summary`/`tags` de OpenAPI.
- **Service + repositório** — todas as queries scoped por `tenantId` (um tenant em
  falta é um `400` claro, nunca um `500` silencioso).
- **Permissões** — um `<name>.permissions.ts` que declara as permissões mais um
  helper `grant<Name>Permissions(store, role)`.
- **Audit** — `AUDIT.record()` ligado no create/update/delete quando o audit está
  ativo.
- **Um teste.**

O model é fundido no `prisma/schema.prisma`; o `--migrate` (ou o prompt depois de
gerar) corre `prisma db push` para criar a tabela e regenerar o cliente.

## O fluxo de trabalho

```bash
export AI_PROVIDER=openai AI_BASE_URL=… AI_API_KEY=… AI_MODEL=…

pnpm basalt ai:make "um módulo de faturas por tenant: número, valor, data de emissão e estado (pago/pendente), ligado a um cliente"
# 1. revê o plano → confirma
# 2. responde 'y' para correr o `prisma db push`
# 3. reinicia o dev server para carregar o cliente Prisma regenerado
```

::: warning Header do tenant
Todas as rotas tenant-scoped precisam do tenant atual — envia o header
`x-tenant-id` (correspondente a um tenant que o teu app resolve). Sem ele, a rota
devolve `400`.
:::

## O Review agent

O `--review` corre uma passagem LLM sobre o **código gerado** e devolve um veredito
com issues por dimensão (tenancy, segurança, RBAC, validação, testes, fit).
Qualquer issue de severidade `error` bloqueia (o comando sai ≠ 0); warnings não.
Ele avalia o vertical de backend nos seus próprios termos — julga, nunca reescreve
código.

## Usar a partir do teu editor (MCP)

Preferes conduzir estes fluxos a partir do **Claude Code** ou **Claude Desktop** em
vez do terminal? O [`@basaltkit/ai-mcp`](./ai-mcp) é uma ponte MCP só-de-dev que
expõe `analyze`, `doctor`, `plan`, `review` e o `make` (seguro, preview primeiro)
como ferramentas MCP — o mesmo motor, no teu editor. Corre `claude mcp add
basalt-ai -- npx -y @basaltkit/ai-mcp --cwd="$PWD"` e pede-lhe para planear uma
funcionalidade.

## Porque é que ser só-dev importa

O `@basaltkit/ai` e o `@basaltkit/generator` são `devDependencies`, registados só
no `bin/basalt.ts`. O `src/server.ts` (o runtime) nunca os importa, por isso um
build de produção corre sem a camada de IA/codegen. Todos os SaaS feitos com o
ecossistema mantêm a mesma arquitetura reutilizável — o framework é dono dela; a IA
é uma ferramenta que a fala.
