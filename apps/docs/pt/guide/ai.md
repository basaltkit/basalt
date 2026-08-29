# Desenvolvimento assistido por IA

O `@basaltkit/ai` é um package de **tempo de desenvolvimento**: um CLI `basalt ai`
(mais o motor por trás dele) que lê o teu projeto, reporta o que está ligado,
diagnostica problemas de configuração e de tenancy, transforma uma frase num plano
de arquitetura e gera um vertical de backend completo pelas convenções do próprio
framework. Está desacoplado da app em execução: nada no `src/server.ts` alguma vez
o importa, e o código que escreve importa apenas os packages oficiais.

::: tip A IA gera código; o framework define a arquitetura.
O `@basaltkit/ai` **nunca é uma dependência de runtime**. O teu SaaS corre
completamente sem ele, e o código gerado importa os packages oficiais (Prisma,
tenancy, permissões, audit…) — nunca o `@basaltkit/ai`. É uma ferramenta que *usa*
a arquitetura, não inventa uma. Um teste no repositório torna isto mecânico —
vê [Porque é que ser só-dev importa](#porque-e-que-ser-so-dev-importa).
:::

[[toc]]

## Onde encaixa a camada de IA

Quatro packages compõem a história de IA/MCP do Basalt. Só o último corre em
produção — esta página é a primeira linha:

| Camada | Package | Papel | Runtime? |
| --- | --- | --- | --- |
| Inteligência | **`@basaltkit/ai`** | **Esta página** — o CLI `basalt ai`, os providers, o motor analyze/doctor/plan/make/review | só dev |
| Ponte de dev | [`@basaltkit/ai-mcp`](/pt/guide/ai-mcp) | Expõe esses mesmos fluxos ao teu editor por MCP | só dev |
| Fio | [`@basaltkit/mcp-core`](/pt/guide/mcp-core) | Protocolo MCP sem dependências + servidor genérico + transportes | partilhado |
| Superfície de runtime | [`@basaltkit/mcp`](/pt/guide/mcp) | As rotas opt-in da tua app tornam-se ferramentas para agentes, em produção | runtime |

O modelo mental numa linha: **o `ai` é o cérebro, o `ai-mcp` é o cabo até ao teu
editor, o `mcp-core` é o fio, o `mcp` é o que o teu produto entrega.**

Dentro do próprio `@basaltkit/ai` há duas metades. A metade **offline**
(`ai:analyze`, `ai:doctor`, `ai:fix`) é um motor de regras determinístico sobre os
teus ficheiros-fonte — sem rede, sem chave, seguro em CI. A metade **com modelo**
(`ai:plan`, `ai:make`, `--review`) chama um LLM através de um provider à tua
escolha. Nenhuma das metades toca na base de dados, exceto o `prisma db push`
explicitamente autorizado.

## Instalação (só dev)

O `create-basalt --cli` já liga isto por ti. Para o adicionar a uma app existente,
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

// buildApp recebe os comandos de dev/CLI só aqui; o src/server.ts omite-os.
const app = buildApp({ commands: [...generatorCommands(), ...aiCommands(), prismaSyncCommand()] })
process.exit(await runCli({ app }))
```

O `aiCommands({ cwd })` fixa opcionalmente a raiz do projeto que os comandos
analisam; caso contrário usam o `process.cwd()`, e todos os comandos aceitam
`--dir=<caminho>` para a substituir em cada invocação.

## Escolher um provider

O motor nunca fala com um SDK de fornecedor — todos os comandos dependem da
interface `AIProvider`, por isso trocar de fornecedor é uma mudança de ambiente,
não de código. O `AI_PROVIDER` seleciona-o (predefinição `anthropic`):

```bash
# Anthropic (predefinição) — o modelo predefinido é claude-sonnet-5
export AI_PROVIDER=anthropic AI_API_KEY=sk-…

# Qualquer gateway compatível com OpenAI (OpenAI, LiteLLM, OpenRouter, go4ai, …)
export AI_PROVIDER=openai AI_BASE_URL=https://o-teu-gateway/v1 AI_API_KEY=… AI_MODEL=…

# Ollama local (sem chave)
export AI_PROVIDER=ollama AI_MODEL=llama3.1
```

| `AI_PROVIDER` | Classe | Modelo predefinido | URL base predefinido | Chave obrigatória |
| --- | --- | --- | --- | --- |
| `anthropic` *(predefinição)* | `AnthropicProvider` | `claude-sonnet-5` | `https://api.anthropic.com` | sim (`AI_API_KEY`) |
| `openai` · `openai-compatible` | `OpenAICompatibleProvider` | `gpt-4o-mini` | `https://api.openai.com/v1` | sim (`AI_API_KEY`) |
| `ollama` | `OllamaProvider` | `llama3.1` | `http://localhost:11434` | não |

O `google` é um nome reconhecido que **lança** deliberadamente — não está
implementado. Qualquer outro valor lança `createProvider: unknown AI_PROVIDER=…`.

::: tip Gateways, streaming e 5xx transitórios
O provider compatível com OpenAI faz streaming por predefinição (SSE) — define
`AI_STREAM=false` para um gateway que não consiga fazer streaming. Todos os pedidos
dos providers passam pelo `fetchWithRetry`, que repete respostas `429` e `5xx` e
erros de rede duas vezes com backoff exponencial (300 ms, depois 600 ms). Um pedido
**cancelado** nunca é repetido. Alguns gateways devolvem um `500` espúrio ao
tamponar uma resposta longa sem streaming; a repetição costuma resolver.
:::

## Comandos

| Comando | O que faz | Precisa de modelo? | Escreve? | Código de saída |
| --- | --- | --- | --- | --- |
| `basalt ai` | Visão geral: stack detetado + comandos disponíveis | não | não | sempre `0` |
| `basalt ai:analyze` | Relatório de stack, modelo de dados e diagnósticos | não | não | sempre `0` |
| `basalt ai:doctor` | Só diagnósticos (não aplica correções) | não | não | `1` se houver alguma ocorrência de severidade **error** |
| `basalt ai:fix [id]` | Aplica um diagnóstico auto-corrigível | não | **ficheiros-fonte** | `1` só se o `id` pedido não tiver auto-correção |
| `basalt ai:plan "…"` | Linguagem natural → plano de arquitetura | **sim** | não | `1` com pedido vazio, sem provider, ou resposta inválida do modelo |
| `basalt ai:make "…"` | Planeia **e** implementa uma funcionalidade | **sim** | **ficheiros-fonte** (+ push de BD opcional) | `1` se o portão de revisão falhar ou algum passo falhar |

### `basalt ai` — a visão geral

Corre a análise e imprime-a, seguida da lista de comandos. As palavras finais são
ecoadas de volta (`basalt ai "adicionar faturas"` reconhece o pedido e encaminha-te
para `ai:plan` / `ai:make`) — a visão geral em si nunca planeia nem escreve.

### `ai:analyze` — entender o projeto

Read-only e offline. Deteta o projeto lendo, a partir da raiz: `package.json`,
`prisma/schema.prisma` (ou `schema.prisma`), `src/app.ts`, `src/server.ts` e
`src/env.ts` (com alternativas `.js` / caminhos alternativos). Daí deriva um
`AnalysisReport`:

| Campo | Conteúdo |
| --- | --- |
| `capabilities` | Linhas legíveis — `Fastify detected`, `Prisma detected`, `PostgreSQL detected`, `Tenancy enabled`, `Authentication enabled`, `RBAC enabled`, `Subscriptions`, `Payments`, `Queue`, `Search`, `Audit`, `Events`, `Scheduler`, `Storage` |
| `installed` | Os packages `@basaltkit/*` encontrados no `package.json` |
| `database` | `postgresql` · `mysql` · `sqlite` · `null` |
| `models` / `tenantScopedModels` / `unscopedModels` | Os models Prisma, separados por terem ou não um `tenantId` |
| `diagnostics` | As mesmas ocorrências que o `ai:doctor` reporta |

A deteção é **estática** — lê as chamadas de plugin no `src/app.ts`, nunca arranca
a tua app, por isso é segura num projeto cuja base de dados esteja em baixo.

### `ai:doctor` — diagnosticar

Corre um motor de regras offline e sai com código ≠ 0 quando alguma ocorrência é de
severidade error, para poderes usar em CI (`basalt ai:doctor` num passo do
pipeline). O conjunto completo de regras:

| Id da regra | Severidade | Categoria | Dispara quando |
| --- | --- | --- | --- |
| `insecure-app-secret` | error | security | O `APP_SECRET` tem um valor predefinido de placeholder no `src/env.ts` |
| `missing-tenant-membership` | error | tenancy | O tenant é resolvido do pedido mas nenhum guard de membership o impõe |
| `prisma-lazy-boot` | warning | observability | A ligação à base de dados não é validada no arranque |
| `fastify-logger-off` | warning | observability | O `fastifyPlugin` está registado sem configuração de `logger` |
| `missing-security-plugin` | warning | security | Não há `securityPlugin` — as respostas seguem sem headers seguros |
| `tenant-scoping-missing` | warning | tenancy | Uma app tenant-scoped tem models Prisma sem `tenantId` |
| `in-memory-security-store` | warning | security | O estado de segurança é guardado num store em memória |
| `memory-sources-in-use` | info | durability | Estão ligadas fontes `Memory*` não-duráveis |
| `redis-localhost-default` | info | config | O `REDIS_URL` aponta por predefinição para localhost |

As regras de tenancy são as que vale mesmo a pena levar a sério — vê
[Tenancy](/pt/guide/tenancy) e [Equipas](/pt/guide/teams) para o guard de
membership que a `missing-tenant-membership` está a pedir.

### `ai:fix` — aplicar uma auto-correção

O `basalt ai:fix <id>` calcula as edições de uma regra; o `basalt ai:fix` sem id
corrige **todas as regras a disparar que tenham auto-corretor**. Em qualquer dos
casos vês primeiro um diff linha-a-linha e depois uma confirmação (salta-a com
`--yes`, ou só pré-visualiza com `--dry-run`).

::: warning Só duas regras são auto-corrigíveis
A `fastify-logger-off` e a `insecure-app-secret` têm edições seguras e precisas.
Todas as outras regras exigem um juízo de valor (que store durável? que model leva
um `tenantId`?) e reportam `no auto-fix — apply manually`. O `ai:fix` é uma
conveniência para as duas mecânicas, não uma ferramenta de reparação geral — lê o
`ai:doctor` e corrige o resto à mão.
:::

Cada alvo reporta um de três estados: `ready` (edições calculadas, serão escritas),
`noop` (`nothing to change (already fixed?)`), ou `unfixable` (sem auto-corretor,
ou `target file not found`).

### `ai:plan` — desenhar primeiro

Transforma uma descrição num **plano de arquitetura** numerado — read-only, não
escreve nada. O plano é fundamentado no teu stack real (o contexto detetado faz
parte do prompt) e nas convenções do Basalt, por isso reutiliza os blocos oficiais:
o gerador `make:resource`, scoping por `tenantId`, permissões RBAC e eventos de
audit. A amostragem é determinística por predefinição (`temperature: 0`,
`maxTokens: 4096`).

O resultado é um `ArchitecturePlan`: um `summary`, `entities` (com campos e
relações), `steps` ordenados, `permissions`, `auditEvents`, `warnings` e um
`schemaVersion`. Esse objeto é a passagem de testemunho para o `ai:make` — e, por
MCP, é o cliente que o transporta entre as duas ferramentas.

### `ai:make` — implementar

Planeia primeiro, mostra-te o plano, pede confirmação e depois gera um vertical de
backend completo, on-convention:

```bash
basalt ai:make "um módulo de faturas por tenant: número, valor, data de emissão e estado (pago/pendente), ligado a um cliente"
```

| Flag | Efeito |
| --- | --- |
| `--dry-run` | Gera em memória, não escreve nada; salta ambos os prompts (ótimo com `--review`) |
| `--yes` | Salta a confirmação — **e consente previamente o `prisma db push`** |
| `--force` | Sobrescreve ficheiros já existentes em vez de recusar |
| `--migrate` | Corre `prisma db push` depois de gerar |
| `--no-migrate` | Suprime por completo o prompt "correr `prisma db push` agora?" |
| `--review` | Um **Review agent** LLM critica o código gerado |
| `--verify` | Corre o typecheck do projeto (`pnpm -s typecheck`) depois de gerar |

::: warning O `--yes` implica `--migrate`
O prompt de confirmação e o prompt de migração são o mesmo consentimento no modelo
do CLI: passar `--yes` aprova previamente a escrita *e* corre o `prisma db push`.
Se queres os ficheiros mas não o push do schema, usa `--no-migrate` em conjunto, ou
responde aos prompts de forma interativa.
:::

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

O model é fundido no `prisma/schema.prisma` (models já presentes ficam intactos) e o
recurso é ligado automaticamente no `src/app.ts`. O passo que as pessoas esquecem é
o push do schema: sem ele o cliente Prisma regenerado não tem delegate para o novo
model e todas as rotas dão 500 — que é exatamente por isso que o comando se oferece
para o correr por ti.

Cada build termina com um **portão de revisão determinístico** (sem modelo
envolvido) que avalia o resultado em: *Tenant isolation* (todos os models
tenant-scoped têm `tenantId`?), *Validation & routes*, *Tests*, *Permissions*,
*Audit* e *Migration*. Um `fail` em qualquer item faz o `ai:make` sair com `1`.

## O fluxo de trabalho

```bash
export AI_PROVIDER=openai AI_BASE_URL=… AI_API_KEY=… AI_MODEL=…

pnpm basalt ai:make "um módulo de faturas por tenant: número, valor, data de emissão e estado (pago/pendente), ligado a um cliente"
# 1. revê o plano → confirma
# 2. responde 'y' para correr o `prisma db push`
# 3. reinicia o dev server para carregar o cliente Prisma regenerado
```

Desenhar primeiro é o ciclo mais seguro, e custa um comando extra:

```bash
pnpm basalt ai:plan "…"                    # lê o plano, não muda nada
pnpm basalt ai:make "…" --dry-run --review # vê os ficheiros + a crítica
pnpm basalt ai:make "…" --verify           # escreve, depois faz typecheck
```

::: warning Header do tenant
Todas as rotas tenant-scoped precisam do tenant atual — envia o header
`x-tenant-id` (correspondente a um tenant que o teu app resolve). Sem ele, a rota
devolve `400`. Vê [Tenancy](/pt/guide/tenancy).
:::

## O Review agent

O `--review` corre uma passagem LLM sobre o **código gerado** e devolve um veredito
com issues por dimensão (tenancy, segurança, RBAC, validação, testes, fit).
Qualquer issue de severidade `error` bloqueia (o comando sai ≠ 0); warnings não.
Ele avalia o vertical de backend nos seus próprios termos — julga, nunca reescreve
código.

A revisão é deliberadamente **não-fatal quando falha a correr**: se o provider der
erro ou o modelo devolver JSON impossível de interpretar, obténs
`Review inconclusive — <razão>` e o build *não* é bloqueado. Uma revisão avariada
nunca deve partir o teu build; uma revisão que correu e reprovou deve.

## Usar a partir do teu editor (MCP)

Preferes conduzir estes fluxos a partir do **Claude Code** ou **Claude Desktop** em
vez do terminal? O [`@basaltkit/ai-mcp`](/pt/guide/ai-mcp) é uma ponte MCP só-de-dev
que expõe `analyze`, `doctor`, `plan`, `review` e o `make` (seguro, preview
primeiro) como ferramentas MCP — o mesmo motor, no teu editor:

```bash
claude mcp add basalt-ai -- npx -y @basaltkit/ai-mcp --cwd="$PWD"
```

Lê as *mesmas* variáveis de ambiente `AI_*` documentadas abaixo.

## Referência de opções

### Flags — todos os comandos `ai:*`

| Flag | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `--dir=<path>` | string | `aiCommands({ cwd })`, senão `process.cwd()` | Analisar/gerar num projeto que não o diretório atual (monorepos, CI) |

### `basalt ai:fix [id]`

| Flag | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `id` (posicional) | string | todas as regras auto-corrigíveis a disparar | Corrigir um diagnóstico em vez de todos os corrigíveis |
| `--dry-run` | boolean | `false` | Imprime o diff e para — nada é escrito |
| `--yes` | boolean | `false` | Salta a confirmação "Apply N fix(es)?" (uso em CI / scripts) |

### `basalt ai:make "<request>"`

| Flag | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `--dry-run` | boolean | `false` | Build em memória: sem escritas, sem prompts. A forma de inspecionar um build antes de confiar nele |
| `--yes` | boolean | `false` | Salta a confirmação de escrita **e** consente previamente o `prisma db push` |
| `--force` | boolean | `false` | Sobrescreve ficheiros existentes; sem ele um conflito aborta com `FileExistsError` |
| `--migrate` | boolean | `false` | Corre `prisma db push` logo após fundir o model |
| `--no-migrate` | boolean | `false` | Nunca oferece o prompt de migração — para quem gere as migrações à mão |
| `--review` | boolean | `false` | Corre o Review agent LLM sobre o código gerado; uma issue de severidade error sai com `1` |
| `--verify` | boolean | `false` | Corre `pnpm -s typecheck` no projeto (timeout de 180 s); uma falha sai com `1` |

### Configuração do provider (ambiente)

Lida por `createProvider(providerEnvFromProcess())` — o CLI e a ponte MCP leem
exatamente o mesmo conjunto.

| Variável | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `AI_PROVIDER` | `anthropic` · `openai` · `openai-compatible` · `ollama` | `anthropic` | Que fornecedor chamar. O `google` é reconhecido mas lança (não implementado) |
| `AI_API_KEY` | string | — | Chave do fornecedor. Obrigatória para `anthropic` e `openai`; não usada pelo `ollama` |
| `AI_MODEL` | string | por provider (vê a tabela de providers) | Fixa um id de modelo específico |
| `AI_BASE_URL` | string | por provider | Aponta para um gateway (`https://…/v1` para compatível com OpenAI) ou um host Ollama não-predefinido |
| `AI_STREAM` | `'false'` desativa | streaming ligado | Desliga o streaming SSE para um gateway compatível com OpenAI que não o suporte |

### `aiCommands(options)`

| Opção | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `cwd` | `string` | `process.cwd()` | Raiz do projeto que os comandos analisam, quando o `--dir` não é passado |

## Modos de falha & resolução de problemas

| Mensagem | Levantada por | Saída | Quando |
| --- | --- | --- | --- |
| `ai:plan needs an AI provider — …` / `ai:make needs an AI provider — …` | `commands.ts` | `1` | O `createProvider` lançou — sem chave, ou um `AI_PROVIDER` desconhecido |
| `AnthropicProvider: apiKey is required (set AI_API_KEY)` | `AnthropicProvider` | `1` | A `AI_API_KEY` está vazia ou por definir |
| `OpenAICompatibleProvider: apiKey is required (set AI_API_KEY)` | `OpenAICompatibleProvider` | `1` | O mesmo, no caminho compatível com OpenAI |
| `createProvider: unknown AI_PROVIDER='x'. Use 'anthropic', 'ollama' or 'openai'.` | `createProvider` | `1` | Gralha no `AI_PROVIDER` |
| `createProvider: 'google' is not implemented …` | `createProvider` | `1` | `AI_PROVIDER=google` — não está ligado |
| `AnthropicProvider: <status> — …` · `OllamaProvider: …` · `OpenAICompatibleProvider: …` | provider | `1` | O gateway devolveu um estado não-OK depois de esgotadas as repetições |
| `ai:plan — the model did not return valid JSON. Got: …` | `parsePlan` | `1` | O modelo embrulhou ou estragou o JSON do plano |
| `ai review — the model did not return valid JSON. Got: …` | `parseReview` | *não fatal* | Aparece como `Review inconclusive — …`; o build continua |
| `ai:make — the plan has no entity to generate.` | `runMake` | `1` | O plano voltou com um array `entities` vazio — reformula o pedido |
| `Refusing to overwrite existing files (use force to replace): …` | `FileExistsError` (`@basaltkit/generator`) | `1` | Um caminho gerado já existe — corre outra vez com `--force` |
| `✗ prisma db push failed: …` | `runPrismaPush` | `1` | `DATABASE_URL` inacessível, ou o model fundido não valida |
| `Usage: basalt ai:plan "<what you want to build>"` | `commands.ts` | `1` | O argumento do pedido estava vazio |
| ``no auto-fix — apply manually (see `basalt ai:doctor`)`` | `planFix` | `1` (só quando foi dado um `id`) | A regra não tem auto-corretor — só duas regras têm |
| `target file not found` | `planFix` | `1` (só quando foi dado um `id`) | O alvo da correção (`src/app.ts`, `src/env.ts`) não foi detetado — o resultado é `unfixable` |

- **Todas as rotas dão 500 logo a seguir ao `ai:make`** — o cliente Prisma não foi
  regenerado. Corre `npx prisma db push` e **reinicia o dev server**; o processo em
  execução mantém o cliente antigo.
- **O `ai:doctor` está verde em dev e vermelho em CI (ou o contrário)** — as regras
  leem ficheiros, não o ambiente. Um layout de checkout diferente (sem `src/app.ts`,
  um caminho de schema não-padrão) faz simplesmente as regras deixarem de disparar;
  corre com `--dir=<raiz do projeto>` a partir da raiz do repositório.
- **O `ai:analyze` reporta que nada está ativo** — a deteção é estática e assenta
  nas *chamadas* de plugin no `src/app.ts`. Se construíres a lista de plugins noutro
  módulo, o detetor não a consegue ver; isso é uma lacuna de deteção, não uma app
  avariada.
- **O provider devolve 500 em gerações longas** — o gateway está a tamponar. Deixa o
  streaming ligado, ou baixa o `maxTokens` via `ai:plan` por MCP; o `AI_STREAM=false`
  torna isto *mais* provável, não menos.
- **O `ai:make --yes` migrou quando não querias** — o `--yes` consente previamente o
  `prisma db push`. Acrescenta `--no-migrate`.
- **Um model tenant-scoped saiu sem `tenantId`** — o portão de revisão determinístico
  reporta-o como falha de `Tenant isolation` e sai com `1`. Corrige o plano (diz "por
  tenant" explicitamente) em vez de remendar o model gerado.

## Porque é que ser só-dev importa

O `@basaltkit/ai` e o `@basaltkit/generator` são `devDependencies`, registados só no
`bin/basalt.ts`. O `src/server.ts` (o runtime) nunca os importa, por isso um build de
produção corre sem a camada de IA/codegen.

Isto não é uma convenção que se peça às pessoas para lembrarem — é **testado**:

- O `packages/ai-mcp/test/dev-only-guard.test.ts` percorre todos os `package.json` do
  workspace e falha se o `@basaltkit/ai` ou o `@basaltkit/ai-mcp` aparecer em
  `dependencies` ou `peerDependencies` em qualquer sítio. As `devDependencies` são a
  única casa legal.
- O `packages/ai-mcp/test/boundary.test.ts` percorre o *grafo de imports transitivo* a
  partir das entradas da ponte de dev e falha se alguma vez chegar ao
  `@basaltkit/core`, `@basaltkit/http`, `@basaltkit/mcp` ou `@basaltkit/cli`.

Assim a fronteira não pode apodrecer em silêncio: no momento em que a camada de IA
tocar no runtime, o CI fica vermelho. Todos os SaaS feitos com o ecossistema mantêm a
mesma arquitetura reutilizável — o framework é dono dela; a IA é uma ferramenta que a
fala.

## Ver também

- [IA no teu editor (ponte MCP)](/pt/guide/ai-mcp) — os mesmos fluxos como ferramentas MCP.
- [MCP (runtime)](/pt/guide/mcp) — as rotas da tua app como ferramentas, em produção. Um
  produto diferente do desta página.
- [`@basaltkit/mcp-core`](/pt/guide/mcp-core) — a camada de protocolo sem dependências sobre a qual ambas as pontes assentam.
- [Tenancy](/pt/guide/tenancy) · [Equipas](/pt/guide/teams) · [Segurança](/pt/guide/security) —
  aquilo para que as regras de tenancy e de segurança do doctor te estão a apontar.
- [Começar](/pt/guide/getting-started) — o `create-basalt --cli` liga a entrada do CLI por ti.
