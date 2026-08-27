# IA no teu editor (ponte MCP)

O `@basaltkit/ai-mcp` é um servidor [Model Context Protocol](https://modelcontextprotocol.io)
**exclusivo de desenvolvimento** que expõe os fluxos de trabalho de IA do Basalt —
analisar, diagnosticar, planear, rever e gerar código — a clientes MCP como o
**Claude Code** e o **Claude Desktop**, através de **stdio** (predefinição) ou HTTP
opcional. Aponta-o ao teu projeto e pede a um agente para construir uma
funcionalidade; ele planeia sobre a tua stack real, pré-visualiza o diff e só
escreve quando tu autorizas.

::: tip É uma ponte, nunca uma dependência de runtime.
O `@basaltkit/ai-mcp` apenas *usa* as APIs públicas oficiais da framework (através
do [`@basaltkit/ai`](./ai)). Depende exclusivamente do `@basaltkit/ai` e do
[`@basaltkit/mcp-core`](./mcp-core) (sem dependências) — **nunca** do
`@basaltkit/core`, `@basaltkit/http` ou do `@basaltkit/mcp` de runtime. Nunca pode
ser dependência de runtime da tua aplicação; instala-o como `devDependency` (ou
corre-o com `npx`). Um teste automático no repositório garante-o.
:::

[[toc]]

## As quatro camadas

O Basalt mantém a inteligência, a ponte de desenvolvimento, o protocolo e o
runtime rigorosamente separados:

| Pacote | Papel | Runtime? |
| --- | --- | --- |
| [`@basaltkit/ai`](./ai) | Inteligência — a CLI `basalt ai`, os providers, o motor plan/make/review | só dev |
| **`@basaltkit/ai-mcp`** | **Esta página.** Um servidor MCP só de dev que expõe esses fluxos a clientes MCP | só dev |
| [`@basaltkit/mcp-core`](./mcp-core) | Protocolo MCP sem dependências: tipos + servidor genérico + transportes stdio/HTTP | partilhado |
| [`@basaltkit/mcp`](./mcp) | A superfície MCP de *runtime* da aplicação — rotas opt-in tornam-se ferramentas | runtime |

O `@basaltkit/ai-mcp` e o `@basaltkit/mcp` falam ambos MCP, mas são produtos
distintos: o `mcp` de runtime expõe *as rotas da tua aplicação* a agentes em
produção; o `ai-mcp` expõe *fluxos de desenvolvimento* (scaffolding, diagnósticos)
ao teu editor enquanto constróis. Nunca os confundas.

## Início rápido (Claude Code / Desktop)

Não é preciso instalar — a ponte corre via `npx`. Lê o teu projeto a partir de
`--cwd`.

### Claude Code

A partir da raiz do teu projeto:

```bash
claude mcp add basalt-ai -- npx -y @basaltkit/ai-mcp --cwd="$PWD"
```

Ou coloca um `.mcp.json` no âmbito do projeto, na raiz do repositório (é o que o
`create-basalt --mcp` gera por ti):

```json
{
  "mcpServers": {
    "basalt-ai": {
      "command": "npx",
      "args": ["-y", "@basaltkit/ai-mcp", "--cwd=."]
    }
  }
}
```

### Claude Desktop

Edita o `claude_desktop_config.json` (Settings → Developer → Edit Config) e
reinicia o Claude Desktop:

```json
{
  "mcpServers": {
    "basalt-ai": {
      "command": "npx",
      "args": ["-y", "@basaltkit/ai-mcp", "--cwd=/caminho/absoluto/para/a-minha-app"]
    }
  }
}
```

### O que já podes pedir

Depois de ligado, o agente conhece a stack e as ferramentas do teu projeto.
Experimenta:

- *"Analisa este projeto Basalt e diz-me o que está ativado."* → `basalt_analyze`
- *"Corre o doctor e mostra-me problemas de tenancy ou segurança."* → `basalt_doctor`
- *"Planeia um recurso Invoice com amount e status, isolado por tenant."* → `basalt_plan`
- *"Pré-visualiza a criação e aplica se parecer seguro."* → `basalt_make`

As ferramentas só-de-leitura (`analyze`, `doctor`) e a **pré-visualização** do
`make` não precisam de chave de API. Planear e rever chamam um LLM — vê
[Configurar o provider](#configurar-o-provider-para-plan-review).

## Criar uma nova app já pronta para MCP

O `create-basalt` liga a ponte por ti quando escolhes MCP:

```bash
npm create basalt my-saas -- --mcp
```

Isto adiciona o `@basaltkit/ai-mcp` às **devDependencies** (nunca dependencies),
escreve um `.mcp.json` na raiz do projeto e documenta-o no README da app. Vê
[`create-basalt`](./getting-started).

## As ferramentas

Cinco ferramentas, mapeadas na superfície da CLI `basalt ai`. O
`structuredContent` espelha a saída em texto em cada chamada e cada ferramenta
anuncia um `outputSchema` derivado dos schemas Zod exportados pelo
[`@basaltkit/ai`](./ai).

| Ferramenta | Objetivo | Precisa de provider? | Escreve ficheiros? |
| --- | --- | --- | --- |
| `basalt_analyze` | Stack detetada, modelo de dados, diagnósticos | não | não |
| `basalt_doctor` | Diagnósticos **+ pré-visualização de correções** | não | não |
| `basalt_plan` | Linguagem natural → `ArchitecturePlan` | **sim** | não |
| `basalt_review` | Crítica LLM de uma implementação → veredicto | **sim** | não |
| `basalt_make` | Gera a vertical de um recurso | preview: não\* / apply: — | **só no apply** |

<small>\* O `basalt_make` só precisa de provider quando passas um `request` em vez
de um `plan` pronto (planeia internamente primeiro).</small>

### `basalt_analyze`

Análise estática e offline. Entrada `{ workspaceRoot? }`; saída um `AnalysisReport`
(capacidades, pacotes instalados, base de dados, modelos, modelos isolados vs não
isolados por tenant, diagnósticos).

### `basalt_doctor`

Diagnostica problemas de configuração, segurança e tenancy e **pré-visualiza** as
correções automáticas disponíveis — os ficheiros que cada uma alteraria, calculado
em memória. Nunca escreve. Saída
`{ diagnostics, hasErrors, fixes: [{ id, status, message, files }] }`.

### `basalt_plan`

Transforma um pedido num `ArchitecturePlan` fundamentado (entidades, passos,
permissões, eventos de auditoria, avisos, `schemaVersion`). Entrada:

```jsonc
{
  "request": "um recurso Invoice: amount, status (pago|pendente), isolado por tenant",
  "workspaceRoot": ".",      // opcional
  "temperature": 0,          // opcional
  "maxTokens": 4096          // opcional
}
```

Só de leitura — produz um plano, não muda nada. Transmite progresso e pode ser
cancelado (vê [Operações demoradas](#operacoes-demoradas)).

### `basalt_review`

Uma passagem LLM sobre um resultado de implementação face ao seu plano (tenancy,
segurança, RBAC, validação, testes, adequação). Entrada `{ plan, makeResult }`;
saída um `AgentReview` cujo `approved` é derivado dos problemas — qualquer problema
de severidade `error` bloqueia.

### `basalt_make`

Implementa um plano: gera a vertical do recurso (schema, repository, service,
routes, testes) e liga-a ao `src/app.ts`. **Seguro por construção** — vê a secção
seguinte. Entrada:

```jsonc
{
  "plan": { /* um ArchitecturePlan do basalt_plan */ },
  // ou, em vez de plan:
  "request": "um recurso Invoice …",   // planeia e depois cria (precisa de provider)
  "workspaceRoot": ".",                 // opcional, confinado ao diretório de arranque
  "mode": "preview",                    // "preview" (predefinição) | "apply"
  "force": false,                       // sobrescrever ficheiros existentes (só apply)
  "migrate": false                      // correr `prisma db push` (só apply)
}
```

A correlação plan↔make é **sem estado**: o cliente transporta o `ArchitecturePlan`
completo (com o seu `schemaVersion`) do `basalt_plan` para o `basalt_make` — não há
armazenamento de planos no servidor.

## `make` seguro

Escrever ficheiros a partir de um agente autónomo é a parte arriscada, por isso o
modelo de segurança é o essencial.

- **A pré-visualização é a predefinição e não escreve nada.** Sem `mode` (ou com
  `mode:"preview"`), a ferramenta devolve `preview.perFile[]` — cada ficheiro que
  *escreveria*, com uma `action` (`create` | `overwrite`) e um **diff unificado** —
  mais `preview.clashes` (caminhos já existentes). Nada toca no disco.
- **O apply é explícito.** É preciso `mode:"apply"` para escrever.
- **Sobrescritas precisam de `force`.** Um `apply` recusa-se a substituir ficheiros
  existentes sem `force:true`.
- **`migrate` tem dupla proteção.** O `prisma db push` só corre com `migrate:true`,
  nunca por predefinição.
- **As escritas são confinadas ao workspace.** Um `workspaceRoot` (ou qualquer
  caminho de destino) que saia do diretório de arranque — via `..`, caminho
  absoluto ou symlink — é rejeitado *antes de qualquer escrita*. Um agente não pode
  escrever fora do teu projeto.
- **Confirmação.** Quando o cliente suporta elicitation do MCP, um `apply` é
  confirmado interativamente; o fluxo explícito preview → apply em duas chamadas é
  o mínimo garantido.

O ciclo recomendado:

```text
basalt_analyze            → perceber a stack
basalt_plan(request)      → obter um ArchitecturePlan
basalt_make(plan)         → PRÉ-VISUALIZAR: ler os diffs + conflitos
basalt_review(plan, prev) → apanhar problemas de tenancy/segurança/RBAC
basalt_make(plan, apply)  → escrever, só quando o preview + review estão bons
```

## Recursos & prompts

### Recursos — puxar o estado do projeto como contexto

Reflexos só-de-leitura do teu workspace que o agente pode ler diretamente:

| URI | Conteúdo |
| --- | --- |
| `basalt://project/context` | O `ProjectContext` detetado — stack, modelos Prisma, ficheiros app/server/env |
| `basalt://project/analysis` | O `AnalysisReport` — capacidades, resumo do modelo de dados, diagnósticos |
| `basalt://project/diagnostics` | Os resultados do doctor |
| `basalt://knowledge/architecture` | As convenções do BasaltKit em que o planeador se baseia |

### Prompts — modelos de fluxo de trabalho

Quatro prompts codificam o ciclo seguro e referenciam as ferramentas pelo nome,
para que até um agente ingénuo faça preview antes de escrever:

| Prompt | Argumentos | Orienta |
| --- | --- | --- |
| `plan-feature` | `request` | analyze → plan → make preview → review → make apply |
| `scaffold-resource` | `name`, `fields?` | criação focada de uma única entidade |
| `harden-tenancy` | — | doctor → rever correções de tenancy → aplicar |
| `add-rbac` | `resource` | ligar guardas de permissões a um recurso |

No Claude Code, os prompts aparecem como slash commands (ex.: `/plan-feature`).

## Configurar o provider (para plan / review)

O `basalt_plan`, o `basalt_review` e o `basalt_make` *com um `request`* chamam um
modelo. A configuração é lida do ambiente com que o cliente MCP arranca o servidor
— as mesmas variáveis que a [CLI `@basaltkit/ai` usa](./ai#escolher-um-provider):

| Variável | Significado |
| --- | --- |
| `AI_PROVIDER` | `anthropic` (predefinição), `openai` (qualquer gateway compatível com OpenAI) ou `ollama` |
| `AI_API_KEY` | A chave do fornecedor (não é preciso para Ollama) |
| `AI_BASE_URL` | URL base do gateway (ex.: um `/v1` compatível com OpenAI) |
| `AI_MODEL` | Sobreposição do id do modelo |

Passa-as pelo bloco `env` do cliente:

```json
{
  "mcpServers": {
    "basalt-ai": {
      "command": "npx",
      "args": ["-y", "@basaltkit/ai-mcp", "--cwd=."],
      "env": { "AI_PROVIDER": "anthropic", "AI_API_KEY": "sk-ant-…" }
    }
  }
}
```

::: warning As chaves ficam em memória
A ponte lê as chaves do provider apenas para construir o provider no processo.
Nunca as regista, persiste ou reproduz. As ferramentas só-de-leitura (`analyze`,
`doctor`) e o preview do `make` não precisam de chave nenhuma.
:::

## Operações demoradas

O `plan`, o `review` e o `make` reportam progresso e podem ser cancelados através
do protocolo MCP:

- **Progresso** — passa um `_meta.progressToken` no teu `tools/call`; a ponte
  emite `notifications/progress` à medida que o modelo transmite e à medida que o
  `make` constrói cada recurso. (O progresso ao vivo requer stdio — vê Transportes.)
- **Cancelamento** — envia `notifications/cancelled` com o id do pedido; a geração
  em curso é abortada prontamente.

## Transportes

| Transporte | Quando | Como |
| --- | --- | --- |
| **stdio** (predefinição) | Dev local; o Claude Code/Desktop arranca o servidor | basta correr o bin |
| **HTTP** (opcional) | Remoto/CI, servidor de equipa | `basalt-ai-mcp --http[=port]` |

```bash
# stdio (predefinição) — o cliente arranca isto
npx @basaltkit/ai-mcp --cwd=.

# HTTP numa porta efémera (imprime o URL); apenas loopback
npx @basaltkit/ai-mcp --http --cwd=.

# HTTP numa porta fixa
npx @basaltkit/ai-mcp --http=8848 --cwd=.
```

O transporte HTTP é JSON-RPC pedido/resposta sobre `POST /mcp` (mínimo, sem SSE);
usa stdio quando precisas de progresso ao vivo.

## Uso programático

Para testes ou incorporação, constrói o servidor sem transporte e comanda-o
diretamente:

```ts
import { buildAiMcpServer } from '@basaltkit/ai-mcp'

const server = buildAiMcpServer({ cwd: '/caminho/para/o/projeto' })
const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
```

O `createAiMcpServer(opts)` arranca stdio; o `createAiMcpHttpServer(opts)` arranca
HTTP. Ambos aceitam `cwd`, um `createReader` injetável (para testes sobre um
projeto em memória) e `createProvider` (para injetar um modelo simulado — sem
rede).

## Resolução de problemas / FAQ

**"basalt_plan needs an AI provider…"** — define `AI_API_KEY` (e opcionalmente
`AI_PROVIDER`/`AI_MODEL`) no bloco `env` do cliente, ou corre o Ollama localmente
(`AI_PROVIDER=ollama`). O `analyze`/`doctor` e o preview do `make` não precisam.

**O agente não vê o meu projeto.** — Confirma que `--cwd` aponta para a raiz do
projeto (onde estão o `package.json` / `prisma/schema.prisma`). Com `.mcp.json`,
`--cwd=.` resolve para o diretório que o Claude Code abriu.

**`basalt_make apply` recusou com "without force".** — Os ficheiros de destino já
existem. Revê os diffs do preview e volta a correr `mode:"apply"` com `force:true`.

**"workspaceRoot escapes the launch directory".** — É intencional: as escritas são
confinadas ao subdiretório de arranque. Usa um caminho dentro do projeto.

**As rotas dão 500 após o apply.** — Foi adicionado um modelo Prisma mas o cliente
não foi regenerado. Volta a correr o `apply` com `migrate:true`, ou corre
`npx prisma db push` tu mesmo, e reinicia o servidor de desenvolvimento.

**É seguro deixar isto ligado?** — Sim. Nada escreve sem um `mode:"apply"`
explícito, sobrescritas precisam de `force`, alterações à BD precisam de `migrate`
e todas as escritas são confinadas ao projeto.

## Ver também

- [Desenvolvimento assistido por IA](./ai) — a CLI `basalt ai` sobre a qual a
  ponte é construída.
- [`@basaltkit/mcp-core`](./mcp-core) — constrói o teu próprio servidor MCP sobre
  o mesmo protocolo.
- [MCP (runtime)](./mcp) — expõe as rotas da tua app como ferramentas em produção.
- Arquitetura: `docs/rfcs/0001-basaltkit-ai-mcp.md`. Fonte:
  `packages/ai-mcp/src/**` (tools, resources, prompts, `safety.ts`, `server.ts`, `bin.ts`).
