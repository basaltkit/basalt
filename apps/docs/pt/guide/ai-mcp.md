# IA no teu editor (ponte MCP)

O `@basaltkit/ai-mcp` é um servidor [Model Context Protocol](https://modelcontextprotocol.io)
**só de dev** que expõe os fluxos de desenvolvimento com IA do Basalt — analyze,
doctor, plan, review e scaffold — a clientes MCP como o **Claude Code** e o
**Claude Desktop**, por **stdio** (predefinição) ou HTTP opcional. Aponta-o ao teu
projeto e pede a um agente que construa uma funcionalidade; ele planeia contra o teu
stack real, pré-visualiza o diff, e só escreve quando tu disseres.

::: tip É uma ponte, nunca uma dependência de runtime.
O `@basaltkit/ai-mcp` apenas *usa* as APIs públicas oficiais do framework (através
do [`@basaltkit/ai`](/pt/guide/ai)). Depende exclusivamente do `@basaltkit/ai` e do
[`@basaltkit/mcp-core`](/pt/guide/mcp-core) (sem dependências) — **nunca** do
`@basaltkit/core`, `@basaltkit/http`, `@basaltkit/cli`, nem do
[`@basaltkit/mcp`](/pt/guide/mcp) de runtime. Instala-o como `devDependency` (ou
corre-o com `npx`). Dois testes impõem isto mecanicamente: o
`packages/ai-mcp/test/boundary.test.ts` percorre o grafo de imports transitivo e
falha se alguma vez chegar ao runtime, e o
`packages/ai-mcp/test/dev-only-guard.test.ts` falha se algum package do workspace
listar a camada de IA fora das `devDependencies`. Em runtime, o servidor **recusa
arrancar com `NODE_ENV=production`** (`AiMcpProductionError`; o bin sai com `1`), por
isso um processo em produção que o tenha puxado falha de forma visível. Só um
`production` explícito recusa — os clientes MCP lançam o bin sem `NODE_ENV`, o caminho
normal de desenvolvimento. Contorna-o deliberadamente com `--allow-production`
(`allowProduction: true`, `BASALT_AI_MCP_ALLOW_PRODUCTION=1`).
:::

[[toc]]

## As quatro camadas

O Basalt mantém a inteligência, a ponte de dev, o fio e o runtime estritamente
separados:

| Package | Papel | Runtime? |
| --- | --- | --- |
| [`@basaltkit/ai`](/pt/guide/ai) | Inteligência — a CLI `basalt ai`, os providers, o motor plan/make/review | só dev |
| **`@basaltkit/ai-mcp`** | **Esta página.** Um servidor MCP só de dev que expõe esses fluxos a clientes MCP | só dev |
| [`@basaltkit/mcp-core`](/pt/guide/mcp-core) | Protocolo MCP sem dependências: tipos + servidor genérico + transportes stdio/HTTP | partilhado |
| [`@basaltkit/mcp`](/pt/guide/mcp) | A superfície MCP de *runtime* da aplicação — rotas opt-in tornam-se ferramentas | runtime |

O `@basaltkit/ai-mcp` e o `@basaltkit/mcp` falam ambos MCP, mas são produtos
diferentes: o `mcp` de runtime expõe *as rotas da tua app* a agentes em produção; o
`ai-mcp` expõe *fluxos de desenvolvimento* (scaffolding, diagnósticos) ao teu editor
enquanto constróis. Nunca confundas os dois.

A ponte em si é fina. Constrói um [`McpServer`](/pt/guide/mcp-core) do `mcp-core`
com cinco ferramentas, quatro recursos e quatro prompts, cada um deles um invólucro
fino sobre uma função exportada do `@basaltkit/ai`. Toda a inteligência vive uma
camada abaixo; toda a *segurança* (confinamento do workspace, preview antes de
escrever) vive aqui.

## Início rápido (Claude Code / Desktop)

Não é preciso instalar — a ponte corre via `npx`. Lê o teu projeto a partir do `--cwd`.

### Claude Code

A partir da raiz do teu projeto:

```bash
claude mcp add basalt-ai -- npx -y @basaltkit/ai-mcp --cwd="$PWD"
```

Ou committa um `.mcp.json` com âmbito de projeto na raiz do repositório (é isto que
o `create-basalt --mcp` gera por ti):

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

Edita o `claude_desktop_config.json` (Settings → Developer → Edit Config) e depois
reinicia o Claude Desktop:

```json
{
  "mcpServers": {
    "basalt-ai": {
      "command": "npx",
      "args": ["-y", "@basaltkit/ai-mcp", "--cwd=/absolute/path/to/my-basalt-app"]
    }
  }
}
```

### O que já podes pedir

Assim que estiver ligado, o agente tem o stack e as ferramentas do teu projeto.
Experimenta:

- *"Analisa este projeto Basalt e diz-me o que está ativo."* → `basalt_analyze`
- *"Corre o doctor e mostra-me problemas de tenancy ou segurança."* → `basalt_doctor`
- *"Planeia um recurso Invoice com valor e estado, por tenant."* → `basalt_plan`
- *"Pré-visualiza a implementação e aplica-a se parecer segura."* → `basalt_make`

As ferramentas read-only (`analyze`, `doctor`) e o **preview** do `make` não precisam
de chave de API. O planeamento e a revisão chamam um LLM — vê Configurar o provider
mais abaixo.

## Criar uma nova app já pronta para MCP

O `create-basalt` liga a ponte por ti quando optas por MCP:

```bash
npm create basalt my-saas -- --mcp
pnpm basalt add mcp          # …ou depois, numa app criada sem --mcp
```

Isto acrescenta o `@basaltkit/ai-mcp` às **devDependencies** (nunca às
dependencies), escreve um `.mcp.json` na raiz do projeto, e documenta-o no README da
app. Vê [`create-basalt`](/pt/guide/getting-started) e
[Acrescentar funcionalidades depois](/pt/guide/installation#acrescentar-funcionalidades-depois).

## As ferramentas

Cinco ferramentas, mapeadas na superfície da CLI `basalt ai`. O `structuredContent`
espelha a saída em texto em todas as chamadas, e cada ferramenta anuncia um
`outputSchema` derivado dos schemas Zod exportados do
[`@basaltkit/ai`](/pt/guide/ai).

| Ferramenta | Objetivo | Precisa de provider? | Escreve ficheiros? |
| --- | --- | --- | --- |
| `basalt_analyze` | Stack detetado, modelo de dados, diagnósticos | não | não |
| `basalt_doctor` | Diagnósticos **+ previews de correções em memória** | não | não |
| `basalt_plan` | Linguagem natural → `ArchitecturePlan` | **sim** | não |
| `basalt_review` | Crítica LLM de um build → veredito | **sim** | não |
| `basalt_make` | Gera um vertical de recurso | preview: não\* / apply: — | **só no apply** |

<small>\* O `basalt_make` só precisa de provider quando lhe passas um `request` em
vez de um `plan` já pronto (planeia internamente primeiro).</small>

Uma falha de ferramenta **nunca** é um erro de protocolo: argumentos inválidos, um
provider em falta, uma escrita recusada e um cancelamento voltam todos como um
resultado normal com `isError: true` e a razão em `content` — para que o agente a
possa ler e adaptar-se. Só JSON-RPC malformado produz um código de erro real.

### `basalt_analyze`

Análise estática e offline. Entrada `{ workspaceRoot? }`; saída um `AnalysisReport`
(capacidades, packages instalados, base de dados, models, models tenant-scoped vs
não-scoped, diagnósticos). O `workspaceRoot` — aqui e no `basalt_doctor` /
`basalt_plan` — fica confinado ao `--cwd` do servidor: um caminho absoluto noutro
sítio, `..`, ou um symlink que resolve para fora é recusado
(`Refused: … is outside the project root`).

### `basalt_doctor`

Diagnostica problemas de configuração, segurança e tenancy, e **pré-visualiza** as
auto-correções disponíveis — os ficheiros que cada uma mudaria, calculados em
memória. Nunca escreve. Saída
`{ diagnostics, hasErrors, fixes: [{ id, status, message, files }] }`, em que
`status` é `ready` · `noop` · `unfixable`.

Nota que `fixes` só lista regras que estão *ao mesmo tempo* a disparar *e* são
auto-corrigíveis — o que hoje são apenas a `fastify-logger-off` e a
`insecure-app-secret`. Tudo o resto em `diagnostics` é correção manual; vê a
[tabela completa de regras](/pt/guide/ai).

### `basalt_plan`

Transforma um pedido num `ArchitecturePlan` fundamentado (entidades, passos,
permissões, eventos de audit, avisos, `schemaVersion`). Entrada:

```jsonc
{
  "request": "an Invoice resource: amount, status (pago|pendente), tenant-scoped",
  "workspaceRoot": ".",      // opcional
  "temperature": 0,          // opcional
  "maxTokens": 4096          // opcional
}
```

Read-only — produz um plano, não muda nada. Faz streaming do progresso e pode ser
cancelado (vê Operações demoradas mais abaixo).

### `basalt_review`

Uma passagem LLM sobre o resultado de um build contra o seu plano (tenancy,
segurança, RBAC, validação, testes, fit). Entrada `{ plan, makeResult }` — ambos
objetos obrigatórios; saída um `AgentReview` cuja flag `approved` é derivada das
issues — uma issue de severidade error bloqueia.

### `basalt_make`

Implementa um plano: gera o vertical do recurso (schema, repositório, service,
rotas, testes) e liga-o no `src/app.ts`. **Seguro por construção** — vê a secção
seguinte. Entrada:

```jsonc
{
  "plan": { /* um ArchitecturePlan vindo do basalt_plan */ },
  // ou, em vez de plan:
  "request": "an Invoice resource …",  // planeia e depois implementa (precisa de provider)
  "workspaceRoot": ".",                 // opcional, confinado ao diretório de arranque
  "mode": "preview",                    // "preview" (predefinição) | "apply"
  "force": false,                       // sobrescreve ficheiros existentes (só no apply)
  "migrate": false                      // corre `prisma db push` (só no apply)
}
```

O schema de entrada declara `oneOf: [{ required: ['plan'] }, { required: ['request'] }]`
— exatamente um dos dois é o ponto de entrada.

A correlação plan↔make é **stateless**: é o cliente que transporta o
`ArchitecturePlan` completo (com o seu `schemaVersion`) do `basalt_plan` para o
`basalt_make` — não há nenhum armazenamento de planos no servidor.

## `make` seguro

Escrever ficheiros a partir de um agente autónomo é a parte arriscada, por isso o
modelo de segurança é o ponto central.

- **O preview é a predefinição e não escreve nada.** Sem `mode` (ou com
  `mode:"preview"`), a ferramenta devolve `preview.perFile[]` — todos os ficheiros
  que *escreveria*, cada um com uma `action` (`create` | `overwrite`) e um **diff
  unificado** — mais `preview.clashes` (caminhos que já existem). Nada toca no disco.
- **O preview corre sempre primeiro.** Mesmo um `apply` calcula o dry run antes de
  escrever, para que a verificação de confinamento abaixo corra contra a lista real
  de alvos.
- **O apply é explícito.** É preciso `mode:"apply"` para escrever.
- **Sobrescrever exige `force`.** Um `apply` recusa-se a esmagar ficheiros
  existentes a menos que `force:true`.
- **O `migrate` tem duplo portão.** O `prisma db push` só corre com `migrate:true`, e
  nunca por predefinição.
- **As escritas estão confinadas ao workspace.** Um `workspaceRoot` (ou qualquer
  caminho-alvo) que escape ao diretório de arranque — via travessia `..`, caminho
  absoluto, ou symlink — é rejeitado *antes de qualquer escrita*. O confinamento
  resolve o realpath do ancestral **existente** mais próximo, por isso uma fuga por
  symlink é apanhada mesmo para um caminho que ainda não existe. Um agente não
  consegue escrever fora do teu projeto.
- **Confirmação — falha fechado.** Um `apply` é confirmado por elicitation MCP com
  um resumo de uma linha do que será escrito. Em stdio isto funciona quando o
  cliente anuncia a capacidade `elicitation` no `initialize`. Quando **não é
  possível** perguntar ao cliente (sem suporte de elicitation, ou o transporte
  HTTP), o `apply` é **recusado** — revê a pré-visualização e aplica-a tu — a não
  ser que o servidor tenha arrancado com `--allow-unconfirmed-apply`
  (programaticamente: `allowUnconfirmedApply: true`).

O ciclo recomendado:

```text
basalt_analyze            → understand the stack
basalt_plan(request)      → get an ArchitecturePlan
basalt_make(plan)         → PREVIEW: read the diffs + clashes
basalt_review(plan, prev) → catch tenancy/security/RBAC issues
basalt_make(plan, apply)  → write, only when the preview + review look right
```

## Recursos & prompts

### Recursos — puxar o estado do projeto como contexto

Reflexos read-only do teu workspace que o agente pode ler diretamente. São
calculados de novo em cada `resources/read`, e sempre contra a raiz de workspace do
**servidor** (`--cwd`) — os recursos não recebem argumentos:

| URI | MIME | Conteúdo |
| --- | --- | --- |
| `basalt://project/context` | `application/json` | O `ProjectContext` detetado — stack, models Prisma, ficheiros app/server/env |
| `basalt://project/analysis` | `application/json` | O `AnalysisReport` — capacidades, resumo do modelo de dados, diagnósticos |
| `basalt://project/diagnostics` | `application/json` | As ocorrências do doctor |
| `basalt://knowledge/architecture` | `text/markdown` | As convenções Basalt em que o planeador é fundamentado (`BASALT_KNOWLEDGE`) |

### Prompts — modelos de fluxo de trabalho

Quatro modelos de prompt codificam o ciclo seguro e referem as ferramentas pelo
nome, para que até um agente ingénuo siga o preview-antes-de-escrever:

| Prompt | Argumentos | Guia |
| --- | --- | --- |
| `plan-feature` | `request` (obrigatório) | analyze → plan → make preview → review → make apply |
| `scaffold-resource` | `name` (obrigatório), `fields` (opcional) | um build focado de uma só entidade |
| `harden-tenancy` | — | doctor → rever correções de tenancy → aplicar |
| `add-rbac` | `resource` (obrigatório) | ligar guards de permissões a um recurso |

No Claude Code, os prompts aparecem como slash commands (ex.: `/plan-feature`).

## Configurar o provider (para plan / review)

O `basalt_plan`, o `basalt_review` e o `basalt_make` *com um `request`* chamam um
modelo. A configuração é lida do ambiente com que o cliente MCP arranca o servidor —
as mesmas variáveis que a [CLI `@basaltkit/ai` usa](/pt/guide/ai):

| Variável | Significado |
| --- | --- |
| `AI_PROVIDER` | `anthropic` (predefinição), `openai` (qualquer gateway compatível com OpenAI), ou `ollama` |
| `AI_API_KEY` | A chave do fornecedor (não é precisa para o Ollama) |
| `AI_BASE_URL` | URL base do gateway (ex.: um `/v1` compatível com OpenAI) |
| `AI_MODEL` | Substituição do id do modelo |
| `AI_STREAM` | `'false'` desativa o streaming SSE no provider compatível com OpenAI |

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
A ponte lê as chaves do provider apenas para construir o provider em processo, e só
quando uma ferramenta que precisa de modelo é de facto chamada (a sessão constrói-o
de forma preguiçosa). Nunca as regista, persiste ou ecoa — e a mensagem de erro do
`providerHelp` que te guia quando falta configuração nomeia deliberadamente apenas
os parâmetros, nunca um valor. As ferramentas read-only (`analyze`, `doctor`) e o
preview do `make` não precisam de chave nenhuma.
:::

## Operações demoradas

O `plan`, o `review` e o `make` reportam progresso e podem ser cancelados através do
protocolo MCP:

- **Progresso** — passa um `_meta.progressToken` no teu `tools/call`; a ponte emite
  `notifications/progress` à medida que o modelo faz streaming e à medida que o
  `make` constrói cada recurso. (O progresso ao vivo exige stdio — vê Transportes.)
- **Cancelamento** — envia `notifications/cancelled` com o id do pedido; a geração em
  curso é abortada prontamente e a ferramenta devolve `isError: true` com o texto
  `Cancelled.`

## Transportes

| Transporte | Quando | Como |
| --- | --- | --- |
| **stdio** (predefinição) | Dev local; o Claude Code/Desktop arranca o servidor | basta correr o bin |
| **HTTP** (opcional) | Remoto/CI, servidor partilhado de equipa | `basalt-ai-mcp --http[=port]` |

```bash
# stdio (predefinição) — o cliente arranca isto
npx @basaltkit/ai-mcp --cwd=.

# HTTP numa porta efémera (imprime o URL); apenas loopback
npx @basaltkit/ai-mcp --http --cwd=.

# HTTP numa porta fixa
npx @basaltkit/ai-mcp --http=8848 --cwd=.
```

O transporte HTTP é JSON-RPC pedido/resposta sobre `POST /mcp` (mínimo, sem SSE);
usa stdio quando precisares de streaming de progresso ao vivo.

::: warning O HTTP é guardado, e liga-se ao loopback por predefinição
O transporte HTTP liga-se a `127.0.0.1` e rejeita pedidos cujo header `Host` não
seja um nome de loopback (anti-DNS-rebinding) ou cujo `Origin`, *quando presente*,
não seja uma origem de loopback (anti-CSRF — um browser envia sempre `Origin` num
POST cross-site, por isso a sua ausência significa um cliente não-browser). Um
pedido rejeitado recebe `403` e nunca chega a uma ferramenta.

Esse guard trava browsers; **não é autenticação** (qualquer cliente que não seja um
browser pode enviar `Host: 127.0.0.1`). Por isso, ligar noutro sítio
(`--host=0.0.0.0` para CI) é **recusado**, a não ser que dês também um token —
`--token=<segredo>` ou `BASALT_AI_MCP_TOKEN` — que todos os pedidos têm então de
enviar como `Authorization: Bearer <segredo>`. Acrescenta os hostnames que os
clientes usam com `--allowed-hosts=ci.internal,…`. Os corpos dos pedidos têm um
tecto de 1 MiB (`413`).
:::

## Uso programático

Para testes ou embedding, constrói o servidor sem transporte e comanda-o
diretamente:

```ts
import { buildAiMcpServer } from '@basaltkit/ai-mcp'

const server = buildAiMcpServer({ cwd: '/path/to/project' })
const res = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
```

O `createAiMcpServer(opts)` arranca em stdio; o `createAiMcpHttpServer(opts)`
arranca em HTTP. Ambos aceitam `cwd`, um `createReader` injetável (para testes sobre
um projeto em memória), e `createProvider` (para injetar um modelo falso — sem rede).

## Referência de opções

### Flags do CLI (`basalt-ai-mcp`)

| Flag | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `--cwd=<path>` | string | `process.cwd()` | A raiz do projeto que todas as ferramentas e recursos leem. Com `.mcp.json`, `--cwd=.` resolve para o diretório que o cliente abriu |
| `--http` / `--http=<port>` | boolean / number | stdio (desligado) | Muda para o transporte HTTP. `--http` sozinho usa a porta `0` — uma porta efémera, impressa no stdout como `basalt-ai-mcp listening on <url>` |
| `--host=<host>` | string | `127.0.0.1` | Endereço de bind; só é lido quando o `--http` está presente. Ligar fora do loopback exige `--token` |
| `--token=<segredo>` | string | `BASALT_AI_MCP_TOKEN` | Só HTTP: exige `Authorization: Bearer <segredo>` em todos os pedidos. Obrigatório para um `--host` fora do loopback |
| `--allowed-hosts=<a,b>` | lista separada por vírgulas | só nomes de loopback | Só HTTP: hostnames `Host` extra a aceitar quando ligado fora do loopback |
| `--sessions` | boolean | desligado (sem estado) | Só HTTP: liga as sessões `Mcp-Session-Id`, para que um `notifications/cancelled` enviado noutro POST cancele uma chamada em curso (vê `sessions` abaixo) |
| `--allow-unconfirmed-apply` | boolean | desligado | Deixa o `basalt_make` aplicar quando o cliente não consegue confirmar (sem elicitation). Desligado por omissão: esse apply é recusado |
| `--allow-production` | boolean | desligado (`BASALT_AI_MCP_ALLOW_PRODUCTION`) | Arranca mesmo com `NODE_ENV=production`. Desligado por omissão: a ponte, só de desenvolvimento, recusa arrancar aí |

### `buildAiMcpServer(options)` · `createAiMcpServer(options)`

`AiMcpOptions` é a configuração da sessão; o `createAiMcpServer` acrescenta os
streams de stdio.

| Opção | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `cwd` | `string` | `process.cwd()` | Raiz de workspace que ferramentas e recursos usam por predefinição; também a raiz de confinamento do `workspaceRoot` de todas as ferramentas (leituras e escritas) |
| `env` | `Record<string, string \| undefined>` | `process.env` | De onde a configuração do provider (e o `NODE_ENV`, para a guarda dev-only) é lida — injeta um ambiente fixo em vez do do processo |
| `createReader` | `(root: string) => ProjectReader` | `nodeReader` | Como os ficheiros do projeto são lidos. Injeta um reader em memória para testar sem disco |
| `createProvider` | `() => AIProvider` | construído a partir do `env` | Injeta um modelo falso — sem rede, sem chaves |
| `allowUnconfirmedApply` | `boolean` | `false` | Deixa o `basalt_make` aplicar sem confirmação por elicitation. Por omissão: recusa (falha fechado) |
| `allowProduction` | `boolean` | `false` | Constrói mesmo com `NODE_ENV=production`. Por omissão: lança `AiMcpProductionError` (o `createAiMcpHttpServer` rejeita com ele) |
| `input` | `NodeJS.ReadableStream` | `process.stdin` | Só stdio: ler JSON-RPC de outro stream (testes) |
| `output` | `{ write(chunk: string): unknown }` | `process.stdout` | Só stdio: escrever JSON-RPC para outro destino (testes) |

O `createAiMcpServer` devolve um `StdioHandle` cujo `close()` desliga o listener do
stdin.

### `createAiMcpHttpServer(options)`

`AiMcpOptions` mais as `ServeHttpOptions` do `mcp-core`. Devolve um
`Promise<HttpHandle>` (`{ port, url, close() }`).

| Opção | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- |
| `port` | `number` | `0` | `0` escolhe uma porta efémera (lê-a de volta em `handle.port` / `handle.url`) |
| `host` | `string` | `'127.0.0.1'` | Endereço de bind. Loopback por predefinição — isto é uma superfície de dev |
| `path` | `string` | `'/mcp'` | Caminho do endpoint JSON-RPC. Sem flag no CLI; só programaticamente |
| `allowedHosts` | `string[]` | só nomes de loopback | Hostnames `Host` extra a aceitar quando ligas deliberadamente fora do loopback. Comparados sem distinguir maiúsculas, porta ignorada |
| `allowedOrigins` | `string[]` | só origens de loopback | Valores `Origin` extra a aceitar (esquema + host + porta completos) |
| `allowRequest` | `(origin, host, req) => boolean` | — | Substituição total do guard; **substitui** as verificações de loopback/`allowedHosts`/`allowedOrigins` |
| `token` | `string` | — | Exige `Authorization: Bearer <token>` (comparação em tempo constante, via `bearerAuthorizer`). Necessário para um `host` fora do loopback |
| `authorize` | `(req) => boolean \| Promise<boolean>` | — | Autenticação própria em vez de `token`; `false` responde `401` |
| `maxBodyBytes` | `number` | `1048576` | Corpos maiores recebem `413` |
| `sessions` | `boolean \| { ttlMs?, maxSessions? }` | `false` | Sessões Streamable-HTTP: o `initialize` responde com um `Mcp-Session-Id`, cada pedido seguinte tem de o levar (`400` sem ele, `404` desconhecido/expirado/alheio — volta a inicializar), `DELETE` termina-a, e um `notifications/cancelled` enviado à parte cancela a chamada que nomeia, só dentro da mesma sessão. Desligado por predefinição para que clientes sem o header continuem a funcionar |
| `principal` | `(req) => string \| undefined` | hash do `Authorization` | A quem pertence uma sessão — um pedido que resolva para outro principal recebe `404` |

### Argumentos das ferramentas

| Ferramenta | Argumento | Tipo | Predefinição | Objetivo |
| --- | --- | --- | --- | --- |
| `basalt_analyze` · `basalt_doctor` | `workspaceRoot` | `string` | `cwd` do servidor | Analisar um subprojeto (absoluto ou relativo). Tem de ficar dentro do `cwd` — imposto, com symlinks resolvidos |
| `basalt_plan` | `request` | `string` | — (obrigatório) | O que construir, em linguagem natural |
| `basalt_plan` | `workspaceRoot` | `string` | `cwd` do servidor | Fundamentar o plano num subprojeto. Tem de ficar dentro do `cwd` — imposto |
| `basalt_plan` | `temperature` | `number` | `0` | Temperatura de amostragem; `0` mantém os planos reprodutíveis |
| `basalt_plan` | `maxTokens` | `integer` | `4096` | Aumenta-o para um plano grande, com várias entidades, que fique truncado |
| `basalt_review` | `plan` / `makeResult` | objeto | — (ambos obrigatórios) | A saída do `basalt_plan` e a saída do `basalt_make` a criticar |
| `basalt_make` | `plan` **ou** `request` | objeto / string | — (exatamente um) | Um plano pronto, ou um pedido para planear primeiro (precisa de provider) |
| `basalt_make` | `workspaceRoot` | `string` | `cwd` do servidor | Tem de ficar dentro do diretório de arranque — imposto, não indicativo |
| `basalt_make` | `mode` | `'preview' \| 'apply'` | `'preview'` | `apply` é o único valor que escreve |
| `basalt_make` | `force` | `boolean` | `false` | Permite sobrescrever os caminhos reportados em `preview.clashes` |
| `basalt_make` | `migrate` | `boolean` | `false` | Corre `prisma db push` depois de escrever (só no apply) |

## Modos de falha & resolução de problemas

As falhas ao nível da ferramenta viajam no resultado (`isError: true`); só JSON-RPC
malformado produz um código de erro de protocolo.

| Mensagem | Tipo | Onde | Quando |
| --- | --- | --- | --- |
| `basalt_plan needs an AI provider — …` (também `basalt_make` / `basalt_review`) | `isError` | `providerHelp` | O `createProvider` lançou — sem `AI_API_KEY`, ou um `AI_PROVIDER` desconhecido |
| `basalt_plan requires a non-empty "request".` | `isError` | `basalt_plan` | O argumento `request` estava em falta ou vazio |
| `basalt_make requires either a "plan" (from basalt_plan) or a "request" to plan.` | `isError` | `basalt_make` | Nenhum dos pontos de entrada foi fornecido |
| `basalt_review requires a "plan" object (from basalt_plan).` / `… a "makeResult" object …` | `isError` | `basalt_review` | Faltava um argumento-objeto obrigatório |
| `Refused: workspaceRoot '<x>' escapes the launch directory (<root>)` | `isError` | `WorkspaceEscapeError` | `basalt_make`: o `workspaceRoot` resolveu fora do `--cwd` — por design |
| `Refused: workspaceRoot '<x>' is outside the project root (<root>)` | `isError` | `WorkspaceEscapeError` | `basalt_analyze` / `basalt_doctor` / `basalt_plan`: o `workspaceRoot` (ou um symlink nele) resolve para fora do `--cwd` |
| `Refused: absolute path not allowed: <p>` · `Refused: path escapes workspace: <p>` · `Refused: path resolves outside workspace via symlink: <p>` | `isError` | `assertConfined` | Um ficheiro-alvo cairia fora do workspace |
| `Refusing to overwrite N existing file(s) without force:true — …` | `isError` | `basalt_make` | Um `apply` esbarrou em `preview.clashes`. Revê os diffs e volta a correr com `force:true` |
| `Apply cancelled — not confirmed.` | `isError` | `basalt_make` | O prompt de elicitation do cliente foi recusado |
| `Refusing to apply without confirmation — …` | `isError` | `basalt_make` | O cliente não suporta elicitation (ou transporte HTTP) e o servidor não arrancou com `--allow-unconfirmed-apply` |
| `Cancelled.` | `isError` | qualquer ferramenta com modelo | Um `notifications/cancelled` abortou a chamada em curso |
| `Unknown tool: <name>` | JSON-RPC `-32602` | `mcp-core` | O cliente chamou uma ferramenta que não é uma das cinco |
| `Method not found: <method>` | JSON-RPC `-32601` | `mcp-core` | Um método MCP fora do conjunto implementado |
| `Forbidden: host/origin not allowed` | HTTP `403` | `serveHttp` | O guard HTTP rejeitou um `Host`/`Origin` estranho antes do dispatch |
| `Unauthorized` | HTTP `401` | `serveHttp` | O `--token` está definido e o bearer token do pedido falta ou está errado |
| `failed to start HTTP server — serveHttp: refusing to bind non-loopback host …` | arranque | bin | `--host` fora do loopback sem `--token` |
| `failed to start … refuses to start with NODE_ENV=production` | arranque (sai com `1`) | bin / `AiMcpProductionError` | `NODE_ENV=production` no bloco `env` do cliente ou na shell, sem `--allow-production` |
| `Bad Request: Mcp-Session-Id header required …` | HTTP `400` | `serveHttp` | O `--sessions` está ligado e o pedido não traz o header de sessão — faz primeiro o `initialize` |
| `Session not found (expired or unknown) — initialize again` | HTTP `404` | `serveHttp` | O `--sessions` está ligado e o id de sessão é desconhecido, expirou ou foi aberto por outro token |

- **O agente não vê o meu projeto** — verifica que o `--cwd` aponta para a raiz do
  projeto (onde vivem o `package.json` / `prisma/schema.prisma`). Os recursos usam
  sempre o `--cwd` do servidor; só as *ferramentas* aceitam um `workspaceRoot` por
  chamada.
- **O `basalt_doctor` mostra erros mas quase nenhum `fixes`** — é o esperado. Só duas
  regras têm auto-corretores; as restantes são decisões manuais deliberadas.
- **As rotas dão 500 depois do `mode:"apply"`** — foi adicionado um model Prisma mas
  o cliente não foi regenerado. Volta a correr o `apply` com `migrate:true`, ou corre
  `npx prisma db push` tu mesmo, e depois reinicia o dev server.
- **O progresso nunca chega** — estás no transporte HTTP. Ele é só pedido/resposta;
  as notificações servidor→cliente precisam de stdio.
- **O servidor arranca mas o cliente não mostra nada** — em stdio, o stdout *é* o
  canal JSON-RPC. Tudo o resto escrito lá corrompe o stream; a própria ponte só
  escreve no stdout em modo `--http`.
- **É seguro deixar isto ligado?** — Sim. Nada escreve sem um `mode:"apply"`
  explícito, sobrescrever exige `force`, mudanças na BD exigem `migrate`, e todas as
  escritas estão confinadas à subárvore do projeto.

## Ver também

- [Desenvolvimento assistido por IA](/pt/guide/ai) — a CLI `basalt ai` sobre a qual a
  ponte é construída, incluindo a tabela completa de regras do doctor e a
  configuração do provider.
- [`@basaltkit/mcp-core`](/pt/guide/mcp-core) — a camada de protocolo; constrói o teu
  próprio servidor MCP sobre ela.
- [MCP (runtime)](/pt/guide/mcp) — expõe as rotas da tua app como ferramentas em produção.
- Arquitetura: `docs/rfcs/0001-basaltkit-ai-mcp.md`. Fonte:
  `packages/ai-mcp/src/**` (tools, resources, prompts, `safety.ts`, `server.ts`, `bin.ts`).
