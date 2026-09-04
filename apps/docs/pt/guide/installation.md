# Instalação

Há duas entradas. O `create-basalt` cria numa só linha uma app com forma de
produção e escreve apenas as funcionalidades que escolheres — nada de código
morto é enviado. Ou acrescentas pacotes `@basaltkit/*` individuais a uma app que
já tens: cada pacote é ESM com tipos, segue o mesmo contrato de plugin e
funciona sozinho. Esta página cobre ambos, mais a CLI `basalt` que gera código
quando já estás dentro de um projeto.

[[toc]]

## Requisitos

| Requisito | Versão | Porquê |
| --- | --- | --- |
| Node.js | **22 ou superior** (`engines: >=22`) | A framework tem como alvo Node moderno; o CI corre o monorepo inteiro em 22 e 24 |
| Gestor de pacotes | pnpm (recomendado), npm, yarn ou bun | Só o `--ui` é exclusivo de pnpm — cria um workspace pnpm |
| Node 22.5+ | para `node:sqlite` | Os stores `*-sqlite` sem dependências (`auth-sqlite`, `teams-sqlite`, …) usam o SQLite embutido do Node |
| Node 22.6+ | para `basalt dev` sem `tsx` | O runner de dev recai em `node --watch --experimental-strip-types` quando o `tsx` não está instalado |
| PostgreSQL / Redis | só em produção | Os stores com Prisma precisam de Postgres ou MySQL; as filas BullMQ e o driver de cache Redis precisam de Redis |

Nada além do Node é preciso para *começar* — o scaffold arranca com stores em
memória. Vê [Persistência e stores duráveis](/pt/guide/persistence) para a troca.

## Scaffold de uma nova app

O comando `create` do teu gestor de pacotes descarrega e corre o scaffolder na
hora — nada para instalar primeiro:

```bash
pnpm create basalt my-saas
# ou
npm create basalt my-saas
# ou
yarn create basalt my-saas
# ou
bun create basalt my-saas
```

Corre-o **sem nome** num terminal e recebes antes o assistente interativo. Passa
flags (ou `-y`) para saltar todas as perguntas.

### O assistente interativo

O assistente só corre quando não deste nome, o stdin é um TTY e não passaste
`--yes` — por isso CI e execuções piped seguem sempre o caminho das flags.
Pergunta, por esta ordem:

1. **Nome do projeto** — por predefinição `my-saas`, validado como nome de
   pacote npm instalável (minúsculas, sem espaços, máximo 214 caracteres,
   `@scope/` opcional).
2. **Ponto de partida** — uma das predefinições abaixo.
3. **Selecionar funcionalidades** — só para a predefinição `custom`; seleção
   múltipla com tenancy e auth já marcadas.
4. **Gestor de pacotes** — pnpm / npm / yarn / bun, assumindo aquele que invocou
   o comando.
5. **Instalar dependências agora?** e **Inicializar um repositório git?** —
   ambos assumem que sim.
6. Um resumo e depois **Criar o projeto?** — responder que não (ou Ctrl+C)
   imprime `Cancelled.` e sai com o código 130, sem escrever nada.

### Predefinições

| Predefinição | Funcionalidades |
| --- | --- |
| **SaaS starter** | tenancy + auth + faturação + CLI |
| **API only** | auth + MCP — sem tenancy, sem UI |
| **Full stack** | tudo, incluindo a web UI |
| **Minimal** | nenhuma — acrescentas depois |
| **Custom** | escolhes da lista de funcionalidades |

## Flags do scaffolder

| Flag | Predefinição | O que faz |
| --- | --- | --- |
| `<name>` (posicional) | — | Nome do projeto e, salvo indicação de `--dir`, a pasta de destino |
| `--dir=<path>` | `./<name>` | Pasta de destino |
| `--no-tenancy` | tenancy **ativa** | Salta multi-tenancy (`@basaltkit/tenancy`, resolvers de header e subdomínio) |
| `--no-auth` | auth **ativa** | Salta autenticação (`@basaltkit/auth`, `APP_SECRET`, `/auth/*`, `mfaRoutes()`) |
| `--billing` | desativado | Inclui subscrições e planos (`@basaltkit/subscriptions`) |
| `--ui` | desativado | Adiciona um frontend `web/` React + shadcn — vê [Web UI](/pt/guide/web-ui). **Força pnpm** |
| `--cli` | desativado | Adiciona `bin/basalt.ts`, o script `basalt`, os geradores e o `prisma:sync` |
| `--mcp` | desativado | Expõe rotas só-de-leitura marcadas como ferramentas MCP em `POST /mcp`, mais um `.mcp.json` para ferramentas de IA — vê [MCP](/pt/guide/mcp) |
| `--install` / `--no-install` | ativo em TTY, desativado em CI | Instala dependências no fim |
| `--git` / `--no-git` | ativo em TTY, desativado em CI | `git init` mais um commit inicial |
| `--pm=<manager>` | autodeteção | Força `pnpm` \| `npm` \| `yarn` \| `bun` |
| `-y`, `--yes` | — | Aceita todas as predefinições, sem perguntas (também desliga o assistente) |
| `-h`, `--help` | — | Imprime a ajuda e sai |

```bash
pnpm create basalt my-saas --billing --cli --install --git   # stack completa, instalada e commitada
npm create basalt service-api --no-tenancy --no-auth         # API mínima
pnpm create basalt agent-api --mcp -y                        # API + ferramentas MCP, sem perguntas
```

O gestor de pacotes é detetado a partir de `npm_config_user_agent` (a variável
que npm, pnpm, yarn e bun definem todos), recaindo em npm. O `--install` e o
`--git` têm três estados: uma flag explícita ganha sempre, e só quando não
passas nenhuma é que o ambiente decide — um TTY que não seja CI recebe ambos,
tudo o resto não recebe nenhum, para que a automação nunca leve com uma
instalação inesperada.

::: warning Aviso: `--ui` requer pnpm
O frontend `web/` é membro de um workspace pnpm (`pnpm-workspace.yaml`), que o
npm, yarn e bun não conseguem instalar nem correr. Pede `--ui` com outro gestor
e o scaffolder avisa que vai mudar para pnpm, e muda.
:::

## O que é gerado

Todos os projetos recebem o mesmo esqueleto; as flags de funcionalidades só
mudam o que está lá dentro:

| Caminho | Conteúdo |
| --- | --- |
| `src/env.ts` | `defineEnv` sobre `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV` (+ `APP_SECRET` via `secret({ minLength: 32 })` com auth) |
| `src/app.ts` | `buildApp()` — config, logger, eventos, headers de segurança, depois tenancy/auth/faturação/MCP/CLI conforme escolhido |
| `src/routes.ts` | `GET /` (um índice amigável) e `GET /health` |
| `src/server.ts` | Arranca, resolve o `FASTIFY`, escuta e encerra em `SIGINT`/`SIGTERM` |
| `tests/app.test.ts` | Um smoke test que arranca a app e chama `/` e `/health` |
| `package.json` | Scripts `dev` (`tsx watch src/server.ts`), `start`, `test`, `typecheck` — mais `basalt` com `--cli` |
| `.env.example`, `.gitignore`, `README.md`, `tsconfig.json`, `pnpm-workspace.yaml` | Estrutura do projeto |
| `bin/basalt.ts` | Com `--cli`: o ponto de entrada da CLI que liga os geradores e o `prisma:sync` |
| `.mcp.json` | Com `--mcp`: regista a ponte `basalt-ai-mcp`, **só de desenvolvimento**, para clientes MCP |
| `web/…` | Com `--ui`: o frontend React + shadcn, membro do workspace pnpm |

Depois os passos seguintes habituais:

```bash
cd my-saas
pnpm install
pnpm dev        # http://localhost:3000  (health check em /health)
pnpm test
```

Para uma execução guiada ponta-a-ponta, vê [Começar](/pt/guide/getting-started).

## Escolher um adaptador HTTP

As rotas são escritas uma vez e correm em qualquer um de três adaptadores —
escolhe o adequado à tua stack (vê [Adaptadores HTTP](/pt/guide/adapters)):

```bash
pnpm add @basaltkit/core @basaltkit/http @basaltkit/fastify fastify          # Fastify
pnpm add @basaltkit/core @basaltkit/http @basaltkit/express express          # Express
pnpm add @basaltkit/core @basaltkit/http @basaltkit/hono hono @hono/node-server  # Hono
```

O scaffolder escreve sempre Fastify; trocar mais tarde é uma mudança de uma
linha, porque a `route()` e os guards vivem no contrato neutro do
`@basaltkit/http`.

## Adicionar a uma app existente

Os pacotes do Basalt adotam-se incrementalmente. Para adicionar multi-tenancy a
uma app que já tens, instala apenas essas peças — funciona da mesma forma em
qualquer adaptador:

```bash
pnpm add @basaltkit/core @basaltkit/tenancy
```

O catálogo completo está na [referência de pacotes](/pt/reference/packages), e
[Migrar do Express](/pt/guide/migrating-from-express) percorre a adoção da
framework uma capacidade de cada vez.

## Scaffold dentro de um projeto

Com `--cli` (ou depois de acrescentares tu o `@basaltkit/cli` +
`@basaltkit/generator`), o `pnpm basalt` gera verticais de recurso completas:

```bash
pnpm basalt make:resource Project                        # repositório em memória
pnpm basalt make:resource Project --prisma               # repositório Prisma + modelo no schema.prisma
pnpm basalt make:resource Project --prisma --soft-delete # + coluna deletedAt e restore
pnpm basalt make:service Project                         # apenas um artefacto
```

O `make:resource` emite um schema, repositório, serviço, plugin de DI, rotas
CRUD tipadas e um teste em `src/modules/<name>/`, e depois **liga o plugin e as
rotas ao `src/app.ts` por ti**. Os modelos ganham `createdAt` + `updatedAt`
automaticamente. O `--soft-delete` acrescenta uma coluna `deletedAt` (o `delete`
marca a linha em vez de a remover, e o `list`/`find` ignoram as linhas
soft-deleted), um método `restore()` e uma rota `POST /projects/:id/restore`.

| Flag do gerador | Aplica-se a | O que faz |
| --- | --- | --- |
| `--prisma` | `make:resource`, `make:repository` | Repositório com Prisma mais um modelo acrescentado ao `schema.prisma` |
| `--soft-delete` | `make:resource` e os artefactos que constrói | Coluna `deletedAt`, `restore()`, rota de restore, leituras filtradas |
| `--dir=<path>` | todos os `make:*` | Raiz de destino (por predefinição, a diretoria atual) |
| `--force` | todos os `make:*` | Sobrescreve ficheiros existentes em vez de recusar |
| `--no-register` | `make:resource` | Salta a ligação automática ao `src/app.ts` |

Os artefactos individuais estão disponíveis como `make:schema`,
`make:repository`, `make:service`, `make:plugin`, `make:routes` e `make:test`.

O que é verdade do projeto inteiro — e não de uma invocação — configura-se onde
os comandos são registados, incluindo o cliente Prisma contra o qual os
repositórios gerados são tipados:

```ts
commandsPlugin(
  generatorCommands({
    prisma: true,
    prismaClient: { import: '../../tenant-db.js', type: 'TenantDb' },
  }),
)
```

Uma aplicação com um segundo cliente (schema-por-tenant, uma réplica de leitura)
precisa disso: contra o `PrismaClient` por omissão o repositório gerado ou não
compila ou, pior, compila contra os modelos errados. As flags continuam a
mandar, nos dois sentidos — o `--no-prisma` sobrepõe-se ao `prisma: true`.

### Comandos embutidos da CLI

O `runCli` oferece sempre estes, além do que qualquer plugin registe:

| Comando | O que faz |
| --- | --- |
| `list` (ou sem comando) | Imprime todos os comandos disponíveis |
| `routes` | As rotas HTTP registadas, lidas do bucket de metadados `http:routes` |
| `schedule:list` | Tarefas agendadas com as suas expressões cron e fusos horários |
| `dev` | Imprime a tabela de rotas e corre a app com watch/restart. `--entry=<file>`, `--worker` (`-w`) para arrancar um worker de fila ao lado, `--queue=<name>` |
| `upgrade` | Aplica os codemods de atualização da framework. `--dry` para pré-visualizar, `--only=<id>`, `--dir=<path>` |
| `publish` | Copia um grupo de stubs para a app (`dockerfile`, `ci`, `editorconfig`). Corre sem id para listar; `--force` para sobrescrever |

Registar o `queuePlugin` acrescenta `queue:work`, `queue:stats`, `queue:retry` e
`queue:jobs` —
vê [Filas e jobs](/pt/guide/queues).

## Modos de falha e resolução de problemas

| Erro | Código de saída | Quando |
| --- | --- | --- |
| `TargetNotEmptyError` — "Target directory … already exists and is not empty" | 1 | O destino tem ficheiros. Escolhe outro nome ou `--dir=` |
| `Cancelled.` (`WizardCancelledError`) | 130 | Ctrl+C, ou responder que não a "Create project?". Nada é escrito |
| `FileExistsError` — "Refusing to overwrite existing files" | 1 | Um alvo de `make:*` já existe. Repete com `--force` |
| `Unknown command "…". Run "basalt list" to see what is available.` | 1 | Gralha, ou o plugin que regista o comando não está no `buildApp` |
| `No entry file found. Looked for src/main.ts, src/server.ts, …` | 1 | `basalt dev` num projeto com outro ponto de entrada — passa `--entry=<file>` |

- **O scaffolder ignorou as minhas flags** — alguns gestores de pacotes guardam
  para si tudo o que vem depois do nome do pacote. Põe as flags depois de `--`:
  `npm create basalt my-saas -- --billing --cli`. O pnpm e o bun reencaminham-nas
  diretamente.
- **"Skipping dependency install (CI/non-interactive)"** — é esperado: sem uma
  flag explícita, só um terminal interativo fora de CI instala. Passa
  `--install` (e `--git`) para forçar.
- **O `--ui` passou a pnpm sem avisar muito** — tem de ser; o pacote `web/` é
  membro de um workspace pnpm. Arranca o frontend com
  `pnpm --filter <name>-web dev` (porta 5180) enquanto o `pnpm dev` serve a API
  na 3000.
- **"Could not auto-wire src/app.ts"** — o `make:resource` só edita um `app.ts`
  que ainda use `fastifyPlugin({ routes: [...] })`. Acrescenta tu o plugin
  gerado a `plugins` e as rotas ao adaptador; de resto os ficheiros gerados
  estão completos.
- **`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`, ou o `--experimental-strip-types`
  é recusado** — estás num Node anterior ao 22.5 / 22.6. Atualiza o Node, ou
  instala o `tsx` (que o scaffold já instala).

## Para onde a seguir

- [Começar](/pt/guide/getting-started) — a execução guiada pela app gerada.
- [Configuração](/pt/guide/config) — o `src/env.ts`, os segredos e o repositório
  de definições.
- [Conceitos Fundamentais](/pt/guide/concepts) — plugins, o container e o
  contexto de pedido.
- [Testes](/pt/guide/testing) — o `createTestApp` e os fakes já incluídos nas
  `devDependencies`.
- [Produção](/pt/guide/production) — stores duráveis, Docker e a checklist de
  deploy.
