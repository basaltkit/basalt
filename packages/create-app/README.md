# create-machize

Gerador de projetos Machize: um único comando (`npm create machize minha-app`) cria uma aplicação SaaS completa e pronta a correr — API tipada, autenticação, multi-tenancy e, opcionalmente, faturação, frontend web e a CLI `mach`. É o ponto de partida do framework: usa-o sempre que quiseres começar um projeto novo.

## O que este módulo resolve

Começar um projeto backend do zero implica dezenas de decisões e ficheiros antes de escrever a primeira linha útil: configurar o TypeScript, escolher o servidor HTTP, organizar as pastas, ligar autenticação, preparar testes… Um **scaffolder** (gerador de projetos) faz esse trabalho por ti: gera a estrutura inicial com boas práticas já aplicadas, para começares logo a construir o teu produto.

O `create-machize` gera uma aplicação **SaaS** (Software as a Service — software vendido por subscrição, normalmente com vários clientes/organizações na mesma instalação) com a forma que os projetos Machize maduros têm em produção: rotas tipadas com validação Zod, logging estruturado, eventos de domínio e, conforme as opções, **multi-tenancy** (vários clientes isolados na mesma aplicação), autenticação (registo/login/refresh), subscrições com planos, um frontend React e a linha de comandos `mach` com geradores de código.

Funciona de duas maneiras: em modo interativo (responde a perguntas no terminal) ou em modo direto com flags (ideal para scripts). Não instala dependências nem toca no git a menos que peças (`--install`, `--git`).

## Instalação

Não precisas de instalar nada — o comando `create` do teu gestor de pacotes descarrega e executa o pacote na hora:

```bash
npm create machize minha-app
# ou
pnpm create machize minha-app
# ou
yarn create machize minha-app
# ou
bun create machize minha-app
```

> Requisitos: Node.js 18+ e um gestor de pacotes. Para projetos com `--ui` é preciso o **pnpm** (explicado abaixo).

## Começar em 5 minutos

1. Cria o projeto (modo interativo — corre sem nome e responde às perguntas):

```bash
npm create machize
```

```
Project name: minha-app
Multi-tenancy? (Y/n) y
Authentication? (Y/n) y
Subscriptions / billing? (y/N) n
Web UI (React + shadcn)? (y/N) n
'mach' CLI (code generators)? (y/N) n
Install dependencies now? (y/N) y
Initialize a git repository? (y/N) y
```

2. Entra na pasta e arranca:

```bash
cd minha-app
npm install     # se não escolheste instalar no passo anterior
npm run dev     # API em http://localhost:3000
```

3. Experimenta:

```bash
curl http://localhost:3000/          # índice com os endpoints disponíveis
curl http://localhost:3000/health    # { ok: true, requestId: ..., tenant: null }
```

4. Corre os testes incluídos:

```bash
npm test
```

## Guia de utilização

### Todas as flags do CLI

```
Usage: npm create machize <name> [options]
```

| Flag | Default | O que faz |
| --- | --- | --- |
| `<name>` | — (pergunta em modo interativo) | Nome do projeto (e da pasta, salvo `--dir`) |
| `--dir=<path>` | `./<name>` | Pasta de destino |
| `--no-tenancy` | tenancy **ligada** | Remove a multi-tenancy (`@machize/tenancy`) |
| `--no-auth` | auth **ligada** | Remove a autenticação (`@machize/auth`, `APP_SECRET`, rotas `/auth/*`) |
| `--billing` | desligado | Inclui subscrições/planos (`@machize/subscriptions`, planos `free` e `pro` de exemplo) |
| `--ui` | desligado | Gera o frontend `web/` (React + shadcn via `@machize/admin-shadcn` + `@machize/sdk`). **Força pnpm** — ver nota abaixo |
| `--cli` | desligado | Gera a CLI `mach` (`bin/mach.ts`, script `pnpm mach`, geradores `make:*` de `@machize/generator`) |
| `--install` | desligado | Instala as dependências no fim (com o gestor detetado/escolhido) |
| `--git` | desligado | Faz `git init` + primeiro commit ("Initial commit from create-machize") |
| `--pm=<manager>` | autodeteção | Gestor de pacotes: `pnpm` \| `npm` \| `yarn` \| `bun` |
| `-y`, `--yes` | — | Salta as perguntas e aceita os defaults |
| `-h`, `--help` | — | Mostra a ajuda e sai |

Notas de comportamento (fiel ao código):

- **Deteção do gestor de pacotes**: por omissão, deteta quem invocou o comando através da variável `npm_config_user_agent` (definida por npm/pnpm/yarn/bun); gestores desconhecidos caem em `npm`. `--pm=` sobrepõe-se.
- **`--ui` força pnpm**: o frontend `web/` é membro de um *workspace* pnpm (declarado no `pnpm-workspace.yaml` gerado). npm, yarn e bun não conseguem instalar nem executar essa estrutura, por isso, se pedires `--ui` com outro gestor, verás `Note: --ui projects are pnpm workspaces — using pnpm instead of <gestor>.` e o pnpm é usado.
- **Modo interativo**: só acontece quando não passas nome, estás num terminal (TTY) e não usaste `--yes`. Ctrl+C durante uma pergunta termina limpo com "Cancelled." (código de saída 130).
- **Pasta ocupada**: se a pasta de destino existir e não estiver vazia, o comando recusa com `Target directory "<dir>" already exists and is not empty.` e sai com código 1.
- No fim, imprime os ficheiros criados e os "Next steps" adequados às tuas escolhas.

### Exemplos de invocação

```bash
# Projeto completo, sem perguntas, com tudo:
pnpm create machize minha-app --billing --ui --cli --install --git

# API mínima (sem tenancy nem auth), noutra pasta:
npm create machize servico-api --no-tenancy --no-auth --dir=./apps/servico-api

# Aceitar todos os defaults sem perguntas:
npm create machize minha-app -y

# Forçar o yarn como gestor:
npm create machize minha-app --pm=yarn --install
```

### O que é gerado

Sempre:

```
minha-app/
├── package.json          # scripts: dev, start, test, typecheck (+ mach com --cli)
├── tsconfig.json         # TypeScript estrito, ESM
├── .env.example          # PORT, HOST, LOG_LEVEL, NODE_ENV (+ APP_SECRET com auth)
├── .gitignore
├── README.md             # instruções adaptadas às opções escolhidas
├── pnpm-workspace.yaml   # allowBuilds do esbuild (+ membro "web" com --ui)
├── src/
│   ├── env.ts            # variáveis de ambiente validadas com Zod (@machize/env)
│   ├── app.ts            # buildApp() com os plugins escolhidos
│   ├── routes.ts         # GET / (índice amigável) e GET /health
│   └── server.ts         # arranque + paragem limpa em SIGINT/SIGTERM
└── tests/app.test.ts     # smoke test adaptado às opções
```

Com `--cli`, acresce `bin/mach.ts` e o script `"mach": "tsx bin/mach.ts"`. Com `--ui`, acresce a pasta `web/` (Vite + React + Tailwind + shadcn, com `web/src/api.ts` construído sobre `@machize/sdk`; com auth ligada inclui ecrã de login/registo).

### Com `--ui`: correr API e frontend

```bash
pnpm install
pnpm dev                              # terminal 1 — API em :3000
pnpm --filter minha-app-web dev       # terminal 2 — UI em http://localhost:5180
```

O servidor de desenvolvimento do Vite faz proxy de `/api` para a API — não há CORS para configurar.

### Com `--cli`: a linha de comandos `mach`

```bash
pnpm mach list                    # comandos disponíveis
pnpm mach routes                  # rotas HTTP registadas
pnpm mach make:resource Project   # gera schema → repositório → serviço → plugin → rotas → teste
```

### Uso programático (Avançado)

O pacote também exporta a API usada pelo executável, para scripts próprios:

```typescript
import { createProject, detectPackageManager, TargetNotEmptyError } from 'create-machize'

const result = await createProject({
  name: 'minha-app',
  dir: './saida/minha-app', // opcional; default: ./<name>
  tenancy: true,
  auth: true,
  billing: false,
  ui: false,
  cli: true,
})
console.log(result.dir)     // caminho absoluto criado
console.log(result.files)   // caminhos relativos, ordenados
console.log(detectPackageManager()) // 'pnpm' | 'npm' | 'yarn' | 'bun'
```

Nota: `createProject` **só escreve ficheiros** — não instala dependências nem inicializa o git (isso é o executável que faz, com `--install`/`--git`).

## Referência da API

Exportado a partir de `create-machize` (para além do executável `create-machize`):

### `createProject(input): Promise<CreateProjectResult>`

`CreateProjectInput`:

| Campo | Tipo | Obrigatório? | Default | Descrição |
| --- | --- | --- | --- | --- |
| `name` | `string` | Sim | — | Nome do projeto |
| `dir` | `string` | Não | `./<name>` (relativo ao cwd) | Pasta de destino |
| `tenancy` | `boolean` | Não | `true` | Incluir multi-tenancy |
| `auth` | `boolean` | Não | `true` | Incluir autenticação |
| `billing` | `boolean` | Não | `false` | Incluir subscrições |
| `ui` | `boolean` | Não | `false` | Gerar o frontend `web/` |
| `cli` | `boolean` | Não | `false` | Gerar a CLI `mach` |

`CreateProjectResult`:

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `dir` | `string` | Caminho absoluto da pasta criada |
| `files` | `string[]` | Ficheiros escritos (relativos, ordenados) |
| `options` | `ProjectOptions` | As opções efetivamente aplicadas (com defaults resolvidos) |

Lança `TargetNotEmptyError` se a pasta de destino existir e não estiver vazia.

### `detectPackageManager(userAgent?): PackageManager`

Deteta o gestor que invocou o comando a partir de `npm_config_user_agent` (ou da string passada). Devolve `'pnpm' | 'yarn' | 'bun'` quando reconhecido; caso contrário `'npm'`.

### `TargetNotEmptyError`

Erro (estende `Error`) com a mensagem `Target directory "<dir>" already exists and is not empty.`

### Tipos exportados

| Tipo | Descrição |
| --- | --- |
| `PackageManager` | `'pnpm' \| 'npm' \| 'yarn' \| 'bun'` |
| `ProjectOptions` | `{ name, tenancy, auth, billing, ui, cli }` — todos resolvidos (sem opcionais) |
| `CreateProjectInput`, `CreateProjectResult` | Descritos acima |

## Erros comuns e soluções (FAQ)

**Criei um projeto com `--ui` e o `npm install` falha (dependências do `web/` não resolvem).**
Este é o erro clássico: o frontend `web/` é membro de um *workspace* **pnpm** (`pnpm-workspace.yaml`). O npm (tal como o yarn e o bun) não lê esse ficheiro, por isso não instala as dependências do `web/` nem consegue lançar o seu servidor de desenvolvimento. Solução: usa pnpm nesse projeto — `pnpm install` na raiz e `pnpm --filter <nome>-web dev` para a UI. (É por isto que o próprio CLI muda para pnpm quando pedes `--ui` com outro gestor.)

**`Target directory "…" already exists and is not empty.`**
A pasta de destino já tem conteúdo. Escolhe outro nome, aponta para outra pasta com `--dir=`, ou esvazia-a primeiro. O gerador nunca escreve por cima de nada.

**Corri o comando num script/CI e ficou pendurado ou não perguntou nada.**
Fora de um terminal interativo (sem TTY) as perguntas são saltadas. Passa sempre o nome e as flags explicitamente — e usa `-y` para garantir que nenhum prompt aparece.

**`(skipped — git unavailable or already a repo)` depois de `--git`.**
O `git init`/commit falhou — ou o git não está instalado, ou a pasta já pertence a um repositório. O projeto fica criado na mesma; trata do git à mão.

**`(install failed — run "pnpm install" yourself)`.**
A instalação automática falhou (rede, versão do Node, etc.). Entra na pasta e corre `pnpm install` (ou o gestor indicado) para veres o erro real.

**Arranquei a app e `GET /auth/login` dá erro de segredo.**
Com auth ligada, o `src/env.ts` exige `APP_SECRET` com pelo menos 16 caracteres (há um default de desenvolvimento `change-me-in-production--`). Copia `.env.example` para `.env` e define um segredo teu antes de ir para produção.

**Quero mudar de ideias depois de gerar (ex.: acrescentar billing).**
Não há comando de "re-scaffold". Ou geras um projeto novo com as flags certas e comparas, ou acrescentas à mão: instala `@machize/subscriptions` e adiciona o `subscriptionsPlugin` ao `src/app.ts` (o README gerado e os templates servem de referência).

## Como se liga aos outros módulos

O `create-machize` não é usado *pela* aplicação — ele escreve a aplicação que usa os outros pacotes:

- **`@machize/core`, `@machize/config`, `@machize/env`, `@machize/events`, `@machize/fastify`, `@machize/logger`** — a base de qualquer projeto gerado (`createApp` + plugins em `src/app.ts`).
- **`@machize/tenancy`** — incluído por omissão (retira com `--no-tenancy`): resolvedores por cabeçalho e subdomínio, com um `MemoryTenantSource` de demonstração.
- **`@machize/auth`** — incluído por omissão (retira com `--no-auth`): rotas `/auth/*` e `APP_SECRET` validado no `env.ts`.
- **`@machize/subscriptions`** — com `--billing`: planos `free`/`pro` de exemplo com trial e limites de funcionalidades.
- **`@machize/cli` + `@machize/generator`** — com `--cli`: o `bin/mach.ts` chama `runCli`, e `commandsPlugin(generatorCommands())` regista os geradores `make:*`.
- **`@machize/sdk` + `@machize/admin-shadcn` + `@machize/admin`** — com `--ui`: o frontend `web/` chama a API através de um cliente tipado e usa os componentes shadcn.
- **`@machize/testing`** — sempre presente nas `devDependencies`, com um smoke test gerado em `tests/app.test.ts`.
