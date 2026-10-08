# Instalação

Há duas entradas. O `create-basalt` cria numa só linha uma app com forma de
produção e escreve apenas as funcionalidades que escolheres — nada de código
morto é enviado. Ou acrescentas pacotes `@basaltkit/*` individuais a uma app que
já tens: cada pacote é ESM com tipos, segue o mesmo contrato de plugin e
funciona sozinho. Esta página cobre ambos, a CLI `basalt` que gera código
quando já estás dentro de um projeto, e como [atualizar uma app](#atualizar-uma-app)
ou [acrescentar uma funcionalidade depois](#acrescentar-funcionalidades-depois).

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
| **SaaS starter** | tenancy + auth + faturação + base de dados + CLI |
| **API only** | auth + MCP — sem tenancy, sem UI |
| **Full stack** | tudo, incluindo a base de dados e a web UI |
| **Minimal** | nenhuma — acrescentas depois |
| **Custom** | escolhes da lista de funcionalidades |

## Flags do scaffolder

| Flag | Predefinição | O que faz |
| --- | --- | --- |
| `<name>` (posicional) | — | Nome do projeto e, salvo indicação de `--dir`, a pasta de destino. `update`, `add`, `doctor` e `info` estão reservados para os [comandos de projeto](#atualizar-uma-app) |
| `--name=<name>` | — | O nome como flag — a forma de criar um projeto chamado literalmente `update`, `add`, `doctor` ou `info` |
| `--dir=<path>` | `./<name>` | Pasta de destino |
| `--no-tenancy` | tenancy **ativa** | Salta multi-tenancy (`@basaltkit/tenancy`, resolvers de header e subdomínio) |
| `--no-auth` | auth **ativa** | Salta autenticação (`@basaltkit/auth`, `APP_SECRET`, `/auth/*`, `mfaRoutes()`) |
| `--billing` | desativado | Inclui subscrições e planos (`@basaltkit/subscriptions`) |
| `--ui` | desativado | Adiciona um frontend `web/` React + shadcn — vê [Web UI](/pt/guide/web-ui). **Força pnpm** |
| `--no-cli` | CLI ativado | Omite o `bin/basalt.ts`, o script `basalt`, os geradores e o `prisma:sync` (todas as apps os têm por omissão) |
| `--mcp` | desativado | Expõe rotas só-de-leitura marcadas como ferramentas MCP em `POST /mcp`, mais um `.mcp.json` para ferramentas de IA — vê [MCP](/pt/guide/mcp) |
| `--prisma` (`--db`) | desativado | Assenta a app em PostgreSQL através do Prisma: `prisma/schema.prisma`, migrações, `src/db.ts`, as stores Prisma e uma verificação no arranque de que a base de dados é a migrada — vê [PostgreSQL com `--prisma`](#postgresql-com-prisma) |
| `--install` / `--no-install` | ativo em TTY, desativado em CI | Instala dependências no fim |
| `--git` / `--no-git` | ativo em TTY, desativado em CI | `git init` mais um commit inicial |
| `--offline` | desativado | Não consulta o registry npm e usa os intervalos de dependências incluídos nesta versão do create-basalt |
| `--pm=<manager>` | autodeteção | Força `pnpm` \| `npm` \| `yarn` \| `bun` |
| `-y`, `--yes` | — | Aceita todas as predefinições, sem perguntas (também desliga o assistente) |
| `-h`, `--help` | — | Imprime a ajuda e sai |

```bash
pnpm create basalt my-saas --billing --install --git   # stack completa, instalada e commitada
npm create basalt service-api --no-tenancy --no-auth         # API mínima
pnpm create basalt agent-api --mcp -y                        # API + ferramentas MCP, sem perguntas
pnpm create basalt my-saas --prisma --billing                # com PostgreSQL desde o primeiro commit
```

O gestor de pacotes é detetado a partir de `npm_config_user_agent` (a variável
que npm, pnpm, yarn e bun definem todos), recaindo em npm. O `--install` e o
`--git` têm três estados: uma flag explícita ganha sempre, e só quando não
passas nenhuma é que o ambiente decide — um TTY que não seja CI recebe ambos,
tudo o resto não recebe nenhum, para que a automação nunca leve com uma
instalação inesperada.

Os projetos novos recebem a **versão publicada mais recente** de cada dependência:
antes de escrever os ficheiros, o scaffolder pergunta ao registry
(`npm_config_registry`, senão `registry.npmjs.org`) a versão `latest` de cada
pacote e escreve `^<latest>`. Os `@basaltkit/*` recebem sempre a última versão;
os pacotes de terceiros (TypeScript, Vitest, React, Vite, Tailwind, …) só a recebem
na major para a qual os templates foram escritos — uma major mais recente mantém o
intervalo incluído e imprime uma `Note:`. Se o registry não estiver acessível, são
usados os intervalos incluídos com uma única linha `Warning:`; o scaffold nunca
falha por causa disso. `--offline` salta a consulta.

Um `latest` de terceiros publicado **dentro da janela de idade mínima do pnpm**
(`minimumReleaseAge` — o pnpm 11 define-a por omissão como um dia) também mantém o
intervalo incluído: `^<latest>` de uma versão publicada há uma hora não pode ser
instalado sob essa política, ao passo que o intervalo incluído deixa o pnpm
escolher ele próprio a versão *madura* mais recente. A idade vem de um
`HEAD <registry>/<name>` barato por pacote de terceiros (o seu `last-modified`);
quando não é possível prová-la, o intervalo incluído é mantido e uma `Note:`
indica-o. A janela segue `pnpm_config_minimum_release_age` /
`npm_config_minimum_release_age` quando definidas. Os `@basaltkit/*` nunca são
verificados — o `pnpm-workspace.yaml` gerado exclui o scope da política.

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
| `src/env.ts` | `defineEnv` sobre `PORT`, `HOST`, `LOG_LEVEL`, `NODE_ENV` (+ `APP_SECRET` via `secret({ minLength: 32 })` com auth), com `{ prefix: 'MY_SAAS' }` — cada variável é lida primeiro como `MY_SAAS_<NOME>`, com recuo para o nome simples (vê [O `--env-file` nunca sobrepõe variáveis exportadas](#o-env-file-nunca-sobrepoe-variaveis-exportadas)) |
| `src/app.ts` | `buildApp()` — config, logger, eventos, headers de segurança + um rate limit global, depois tenancy/auth/faturação/MCP/CLI conforme escolhido. Com tenancy + auth: `teamsPlugin()` + `tenantMembershipPlugin()` (pedidos autenticados para um tenant de que o utilizador não é membro recebem `403`) e um seed só de dev que adiciona quem se regista ao tenant `demo` |
| `src/routes.ts` | `GET /` (um índice amigável) e `GET /health` |
| `src/server.ts` | Arranca, resolve o `FASTIFY`, escuta e encerra em `SIGINT`/`SIGTERM`. O `pnpm start` corre a sua forma compilada (`dist/src/server.js`) em node puro e **não** carrega nenhum `.env` — a configuração de produção vem do ambiente real |
| `src/dev.ts` | A entrada do `pnpm dev`: carrega o `.env` quando existe (as variáveis exportadas ganham), define `NODE_ENV=development` se ainda não estiver definido e carrega o `server.ts` |
| `tests/app.test.ts` | Um smoke test que arranca a app e chama `/` e `/health` |
| `package.json` | Scripts `dev` (`tsx watch src/dev.ts`), `build` (`tsc -p tsconfig.build.json`), `start` (`node --enable-source-maps dist/src/server.js` — faz build primeiro; um `NODE_ENV` não definido conta como produção), `start:dev` (`tsx src/server.ts`, o servidor a partir do código-fonte sem build), `test`, `typecheck`, `basalt` (`tsx bin/basalt.ts` por omissão, `create-basalt --project` com `--no-cli`, para que o `pnpm basalt update` funcione em qualquer app) e, com `--ui`, `dev:web`. O `create-basalt` é uma devDependency. As versões `@basaltkit/*` seguem a linha de release atual de cada pacote |
| `.basalt/project.json` | O manifesto do scaffold: versão do create-basalt, opções e um hash de cada ficheiro gerado — faz commit dele; o [`add`](#acrescentar-funcionalidades-depois) e o [`update`](#atualizar-uma-app) usam-no para distinguir ficheiros do template intactos dos editados |
| `.env` | Valores locais de desenvolvimento — uma cópia do `.env.example` mais, com auth, um `APP_SECRET` gerado. Ignorado pelo git, modo `0600`, nunca no manifesto; o `pnpm dev` e o `pnpm basalt` carregam-no, o `pnpm start` não |
| `tsconfig.build.json`, `Dockerfile` | O [caminho de produção](/pt/guide/production#build-e-envio): o `pnpm build` compila o `src/` para `dist/` (rootDir `.`, por isso `src/server.ts` → `dist/src/server.js`); o `Dockerfile` multi-stage — o mesmo ficheiro que o `basalt publish dockerfile` escreve — faz o build da app e corre-a em node puro como o utilizador `node` |
| `.env.example`, `.gitignore`, `.dockerignore`, `README.md`, `tsconfig.json`, `pnpm-workspace.yaml` | Estrutura do projeto (o `.dockerignore` mantém o `.env` e as chaves fora das camadas da imagem; o `.env.example` usa os nomes com prefixo da app e, com o README, explica a [armadilha de precedência do `--env-file`](#o-env-file-nunca-sobrepoe-variaveis-exportadas); o `pnpm-workspace.yaml` exclui `@basaltkit/*` e `create-basalt` do `minimumReleaseAge` e documenta as [definições do pnpm 11](#pnpm-11-idade-minima-e-verifydepsbeforerun)) |
| `prisma/schema.prisma`, `prisma.config.ts`, `src/db.ts`, `prisma/seed.ts` | Com `--prisma`: o schema (os modelos de cada domínio Basalt ativo mais os teus), a configuração do Prisma 7 com o URL de ligação, o(s) cliente(s) que a app usa e o seed do tenant `demo` |
| `bin/basalt.ts` | Por omissão (não com `--no-cli`): o ponto de entrada da CLI que liga os geradores e o `prisma:sync`. Reencaminha `update`, `add`, `doctor` e `info` para o create-basalt e corre o `upgrade` (os codemods) **antes** de importar a app, para funcionarem mesmo com a app partida a meio de uma atualização; depois carrega o `.env` (as variáveis exportadas ganham) e transforma um ambiente inválido, uma base de dados inacessível ou por migrar numa correção legível em vez de um stack trace |
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

### PostgreSQL com `--prisma`

**Sem a flag, o scaffold não tem base de dados nenhuma.** Arranca sobre fontes
em memória (`MemoryUserSource`, `MemoryTenantSource`, as stores predefinidas de
equipas e subscrições): ótimo para a primeira execução, para CI e para testes, e
perdido no reinício seguinte. Trocar uma store de cada vez está descrito em
[Persistência e stores duráveis](/pt/guide/persistence).

O `--prisma` (ou `--db`, se preferires) gera antes a forma assente em base de
dados:

| Ficheiro | O que é |
| --- | --- |
| `prisma/schema.prisma` | Os modelos de referência de cada pacote `@basaltkit/*-prisma` que o projeto usa — exatamente o que o [`basalt prisma:sync`](/pt/guide/persistence) junta — mais o teu modelo `Project` |
| `prisma.config.ts` | No Prisma 7 o URL de ligação vive aqui, não no schema. Lê primeiro `MY_SAAS_DATABASE_URL` e só depois o `DATABASE_URL` simples — a mesma precedência do `src/env.ts`, para que a CLI e a app nunca falem de bases de dados diferentes |
| `src/db.ts` | `prisma` (sem escopo — usado pelas stores do framework) e, com tenancy, `db = prisma.$extends(tenancyExtension())`, o cliente que cada pedido recebe |
| `src/app.ts` | `prismaPlugin({ client: db, assertMigrated: true })` mais `prismaTenantSource`, `prismaAuthStores`, `prismaTeamsStores` e `prismaSubscriptionsStores` no lugar das versões em memória |
| `prisma/seed.ts` | O tenant `demo` que os resolvers de header e de subdomínio esperam |

O `MY_SAAS_DATABASE_URL` passa a ser uma variável **obrigatória** (`src/env.ts`)
e o `.env.example` inclui-a já sem comentário. Os scripts do `package.json` são
`db:migrate` (`prisma migrate dev`), `db:deploy` (`prisma migrate deploy`),
`db:generate` e `db:seed`; o `postinstall` corre `prisma generate` para que o
`pnpm typecheck` tenha os tipos do cliente logo a seguir à instalação. O cliente
é gerado em `generated/prisma` — **fora** do `src/`, para que o `pnpm build` nunca
o tenha de copiar — e o `src/db.ts` importa-o como `#db/client.js` através do
alias `imports` do package.json (`"#db/*": "./generated/prisma/*"`), que resolve
da mesma forma a partir do `src/` (tsx, vitest) e do `dist/src/` (node). O
`@prisma/client-runtime-utils` é uma dependência direta porque o runtime gerado o
pede pelo nome, e o `pnpm-workspace.yaml` aprova os scripts de build do `prisma`
/ `@prisma/engines` (o pnpm 11 falha a instalação com um por aprovar). Vê
[Prisma com pnpm](/pt/guide/persistence#prisma-com-pnpm-o-cliente-gerado).

```bash
pnpm create basalt my-saas --prisma
cd my-saas && pnpm install
# o .env aponta MY_SAAS_DATABASE_URL para postgres://…@localhost:5432/my_saas — arranca o PostgreSQL ou edita-o
pnpm db:migrate          # cria as tabelas e semeia o tenant demo
pnpm dev
```

::: warning Migrações, nunca `db push`
O `src/app.ts` gerado arranca com `assertMigrated: true`, que recusa arrancar a
menos que a base de dados alcançada tenha a tabela `_prisma_migrations` —
escrita pelo `prisma migrate dev` / `migrate deploy` e **não** pelo
`prisma db push`. É essa verificação que transforma um `DATABASE_URL` errado
(uma shell que exportou o de outro projeto, uma gralha no nome da base de dados)
num erro de arranque que nomeia a base de dados e o host, em vez de um `500` no
primeiro pedido que toque numa tabela inexistente.
:::

O `tests/app.test.ts` gerado salta-se a si próprio quando não há base de dados
configurada, por isso o `pnpm test` continua verde numa máquina sem PostgreSQL.

### O `--env-file` nunca sobrepõe variáveis exportadas

O `src/env.ts` valida o `process.env` e mais nada. **Em desenvolvimento o
scaffold carrega o `.env` por ti:** o `src/dev.ts` (`pnpm dev`) e o
`bin/basalt.ts` (`pnpm basalt`, gerado por omissão) chamam `process.loadEnvFile()` sobre
o `.env` do projeto quando existe, antes de a app ser importada. **O
`pnpm start` não** — corre o `src/server.ts` compilado, a entrada de produção, e a configuração
de produção vem do ambiente real (ou arranca-o tu com `node --env-file=…`). Uma
app nova já traz um `.env`: os valores do `.env.example` e, com auth, um
`APP_SECRET` gerado — ignorado pelo git, por isso o segredo nunca chega ao
repositório.

Carregar o `.env` funciona exatamente como `node --env-file=.env` (ou
`tsx --env-file=.env`): o Node **só preenche as variáveis que ainda não estão
definidas** — um valor exportado na tua shell ganha sempre. Com nomes genéricos
isto morde em silêncio — num terminal onde outro projeto exportou `DATABASE_URL`
ou `PORT`, a app arranca contra *essa* base de dados ou porta e só falha no
primeiro pedido que lhe toca.

**A correcção que o scaffold aplica: um prefixo próprio da app.** O `src/env.ts`
passa `prefix` ao `defineEnv`, derivado do nome do projeto (`my-saas` →
`MY_SAAS`), e o `.env.example` usa os nomes com prefixo:

```ts
// src/env.ts — gerado
export const env = defineEnv(
  {
    PORT: z.coerce.number().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
    APP_SECRET: secret({ minLength: 32, devDefault: 'dev-only-insecure-secret-please-change-me' }),
  },
  { prefix: 'MY_SAAS' },
)
```

```bash
# .env.example — gerado
MY_SAAS_PORT=3000
MY_SAAS_HOST=0.0.0.0
MY_SAAS_LOG_LEVEL=info
NODE_ENV=development            # nunca leva prefixo — convenção do Node
# MY_SAAS_APP_SECRET=           # com auth
```

Cada variável é lida primeiro como `MY_SAAS_<NOME>` e **recua** para o nome
simples `<NOME>`, por isso um deployment que já exporta os nomes genéricos
continua a arrancar — enquanto um `PORT` perdido na tua shell deixa de ganhar.
As chaves do shape não mudam — a app continua a ler `env.PORT`. Para eliminar o
recuo e exigir apenas os nomes com prefixo, escreve
`prefix: { value: 'MY_SAAS', fallback: false }`. Quando falta uma variável, o
relatório nomeia o que foi procurado —
`MY_SAAS_DATABASE_URL (or DATABASE_URL): Required`. Regras completas:
[Configuração → Prefixos próprios da app](/pt/guide/config#prefixos-proprios-da-app).

Quando uma variável é inválida ou falta, o `pnpm basalt <comando>` imprime as
variáveis do relatório, de onde foram lidas (o teu ambiente, e o `.env` quando
existe) e a correção — `cp .env.example .env`, preenche-as e, para o
`DATABASE_URL`, arranca o PostgreSQL — e sai com 1 sem stack trace (o
`BASALT_DEBUG=1` ou `--debug` mostra-o). O `pnpm basalt doctor` verifica as
mesmas variáveis sem arrancar a app. A base de dados tem o mesmo tratamento:
quando o PostgreSQL não responde (`ECONNREFUSED`, `P1001` do Prisma, ou um
`assertMigrated` que nem a conseguiu consultar) ou a base de dados não está
migrada (`PRISMA_NOT_MIGRATED`), a mensagem diz o que falhou, que base de dados
a app usou — `postgres://host:porta/nome` e a variável de onde veio, nunca o
utilizador nem a password — e a correção: arranca o PostgreSQL
(`docker compose up -d`, ou o teu serviço local), verifica o
`MY_SAAS_DATABASE_URL`, corre `pnpm db:migrate`. Qualquer outro erro de arranque
mantém o stack trace.

Dois hábitos que continuam a ajudar:

- Na dúvida, `env | grep DATABASE_URL` antes do `pnpm dev`, ou arranca com o
  ambiente limpo: `env -u DATABASE_URL pnpm dev`.
- Quando ligares uma base de dados, regista o seu alvo no arranque (host e nome
  da base de dados, nunca a password), para que um alvo errado apareça logo na
  primeira linha do output.

### pnpm 11: idade mínima e `verifyDepsBeforeRun`

Dois comportamentos do pnpm 11 moldam o `pnpm-workspace.yaml` gerado:

- **O `minimumReleaseAgeExclude` é avaliado pelo primeiro que corresponde ao nome
  do pacote.** Duas entradas para o mesmo pacote (`'@types/node@22.20.4'` e
  `'@types/node@26.6.2'`) não se somam — só a primeira se aplica. Exclui várias
  versões de um pacote com uma única entrada em união, como mostra o comentário
  gerado:

  ```yaml
  minimumReleaseAgeExclude:
    - '@basaltkit/*'
    - '@types/node@22.20.4 || 26.6.2'
  ```

- **O `verifyDepsBeforeRun` é `install` por omissão.** Antes de cada
  `pnpm <script>` *e* `pnpm exec`, o pnpm verifica se o `node_modules` corresponde
  aos manifestos de todos os projetos do workspace (incluindo o `web/` com
  `--ui`); se não corresponder, corre primeiro `pnpm install` — rede e
  verificações de supply chain incluídas. Por isso `pnpm basalt make:resource …`
  é na prática `pnpm install && basalt …` logo a seguir a qualquer alteração de
  dependências. Duas saídas conscientes:

  ```bash
  node_modules/.bin/tsx bin/basalt.ts make:resource Project   # sem pnpm, sem verificação prévia
  ```

  ou descomenta `verifyDepsBeforeRun: warn` no `pnpm-workspace.yaml` — o pnpm
  passa a só avisar, e correr `pnpm install` depois de alterar dependências fica
  a teu cargo. O scaffold mantém a predefinição do pnpm e o script `basalt` como
  `tsx bin/basalt.ts`.

## Atualizar uma app

Qualquer app — gerada com ou sem a CLI (`--no-cli`), por qualquer versão do create-basalt
— passa para as versões mais recentes das dependências num só comando:

```bash
pnpm basalt update --dry          # o plano, nada escrito
pnpm basalt update                # pergunta, escreve, instala, corre os codemods
npx create-basalt@latest update   # o mesmo, numa app sem o script basalt
```

Aplica a **mesma política de um scaffold novo** (é o mesmo código de registry):

- `@basaltkit/*` e `create-basalt` vão para `latest`, atravessando majors. Cada
  major da framework imprime um link para o CHANGELOG do pacote e para as
  [notas de atualização](/pt/guide/whats-new#atualizacao) — lê-as antes de aplicar.
- Os pacotes de terceiros vão para a versão mais recente **no major atual da
  app**; um major mais novo aparece como `kept … pass --major` e só é aceite com
  `--major`.
- Uma versão mais nova do que a janela de idade mínima (o `minimumReleaseAge` do
  pnpm, lido do `pnpm-workspace.yaml` do projeto quando definido) fica para mais
  tarde, para que a instalação não a possa recusar.
- Quando uma release da framework declara um intervalo de peer que a app não
  cumpriria (por exemplo `zod ^5` com o zod retido no 4), o plano avisa antes de
  escrever o que quer que seja.

```text
4 update(s):

  package          in    current     target   kind
  @basaltkit/core  .     ^1.5.0   →  ^2.0.0   MAJOR
  zod              .     ^4.6.5   →  ^4.9.0   minor
  react            web/  ^19.3.0  →  ^19.9.0  minor
  zod              web/  ^4.6.5   →  ^4.9.0   minor

  kept typescript ^7.0.2: 8.0.0 is a new major — pass --major to take it

Framework majors — read before applying:
  @basaltkit/core 1.5.0 → 2.0.0: https://github.com/basaltkit/basalt/blob/main/packages/core/CHANGELOG.md
```

O `package.json` e o `web/package.json` são editados **no próprio sítio** — só
mudam as strings de versão; a ordem das chaves, a indentação e o estilo do
intervalo (`^`, `~`, exato) mantêm-se, e os intervalos que não gere
(`workspace:`, tags, git, `>=`) ficam como estão. O lockfile nunca é editado à
mão: o gestor de pacotes detetado (campo `packageManager`, depois o lockfile)
instala, correm os codemods de atualização do `@basaltkit/cli` instalado sem
arrancar a app, e o comando termina com `pnpm typecheck && pnpm test`. Se a
instalação falhar, as edições ficam e o comando diz como revertê-las com git.

| Flag | O que faz |
| --- | --- |
| `--dry` | Imprime o plano; não escreve nada |
| `-y`, `--yes` | Aplica sem perguntar — obrigatório quando o stdin não é um terminal (CI) |
| `--major` | Deixa também os pacotes de terceiros atravessar um major |
| `--only=@basaltkit` | Só os pacotes da framework (e o `create-basalt`) |
| `--no-install` | Escreve o `package.json`, salta a instalação e os codemods |
| `--no-tooling` | Não mexe no `bin/basalt.ts`, no `src/dev.ts`, no `.env.example` nem na devDependency `create-basalt` |
| `--pm=<manager>`, `--cwd=<dir>`, `--no-color` | Sobrepõem o gestor de pacotes / a pasta alvo; saída simples (também `NO_COLOR`) |

O `--offline` é recusado — o `update` precisa do registry. As ferramentas do
projeto vêm por arrasto: uma app sem a devDependency `create-basalt` recebe-a
(mais um script `basalt`); um `bin/basalt.ts` gerado por uma versão anterior
aprende os comandos de projeto, o carregamento do `.env`, um `upgrade` antes do
arranque e o erro de ambiente legível; um `src/dev.ts` do create-basalt 1.9/1.10
aprende a carregar o `.env`; e o cabeçalho do `.env.example` deixa de dizer que
"nada carrega este ficheiro". Cada ficheiro só é corrigido **quando** é byte a
byte um template conhecido ou o manifesto o regista como intacto. Um
personalizado fica como está e é impresso o excerto exato a colar.

A uma app anterior ao [caminho de produção](/pt/guide/production#build-e-envio)
é **oferecido** o que lhe falta, no mesmo plano: `tsconfig.build.json`, um script
`build`, o `Dockerfile` (apps pnpm) e o `.dockerignore`, e — com Prisma — o
`@prisma/client-runtime-utils` como dependência direta. Ficheiros que já existem
nunca são tocados, e **um script `start` existente nunca é reescrito**: passá-lo
de `tsx src/server.ts` para o servidor compilado muda a forma como a app é
implantada, por isso são impressas as duas linhas de script a colar. Um cliente
Prisma ainda gerado em `src/generated` recebe as instruções para o mover (o
`output` do schema, o alias `#db/*`, o import do `src/db.ts`, o `.gitignore`) e
nenhum Dockerfile até ser movido — o tsc não copia os ficheiros `.js` gerados.

## Acrescentar funcionalidades depois

Não escolheste `--ui`, `--cli` ou `--mcp` ao criar? Acrescenta agora — sem
recriar o projeto:

```bash
pnpm basalt add ui --dry   # o que seria criado, fundido e saltado
pnpm basalt add ui         # o web/ exatamente como o --ui o gera
pnpm basalt add cli        # bin/basalt.ts + @basaltkit/cli, generator e prisma:sync
pnpm basalt add mcp        # @basaltkit/mcp em POST /mcp + a ponte ai-mcp só de dev + .mcp.json
```

O `add` adapta os templates ao projeto tal como está agora (o nome, a auth e a
tenancy a partir das dependências) e planeia todas as alterações antes de
aplicar qualquer uma:

- **Ficheiros existentes nunca são sobrescritos** — são saltados com um aviso;
  o `--force` sobrescreve os ficheiros gerados.
- **Ficheiros partilhados são fundidos:** `package.json` (novas dependências na
  posição ordenada, scripts como `dev:web`; uma entrada existente nunca é
  alterada), `pnpm-workspace.yaml` (`web` acrescentado a `packages:`),
  `.gitignore` e `README.md`.
- **O teu código** (`src/app.ts`, `src/routes.ts`) só é regenerado quando o
  `.basalt/project.json` prova que está intacto, é corrigido onde as âncoras do
  template ainda são inequívocas — tanto `fastifyPlugin` como `expressPlugin` e
  `honoPlugin` — e, caso contrário, fica como está, com os passos manuais exatos
  impressos.
- O `add ui` precisa de pnpm (o `web/` é membro do workspace) e não altera
  código da API: o dev server do Vite faz proxy de `/api`, portanto não há CORS
  para configurar.
- As dependências são instaladas no fim (`--no-install` para saltar); o
  `--offline` usa os intervalos incluídos no create-basalt em vez do registry.

Um projeto criado sem `--ui` a que depois se faz `add ui` fica com os mesmos
ficheiros que um criado com `--ui` — a suite de testes do create-basalt verifica
exatamente isso, e que ambos passam o typecheck.

## Verificar um projeto: `doctor` e `info`

```bash
pnpm basalt doctor     # só de leitura; sai com 1 em erros, 0 só com avisos
pnpm basalt info       # resumo de versões para colar em relatórios de bugs
```

O `doctor` verifica o Node face a `engines` e ao `>=22.5.0` do Basalt; o gestor
de pacotes e os lockfiles; as versões instaladas face às declaradas, versões
`@basaltkit/*` duplicadas e intervalos de peer por cumprir; pacotes da
framework atrás de `latest` (o `--offline` salta isto); o segredo da auth
(`<PREFIXO>_APP_SECRET`, do ambiente ou do `.env`, face ao `minLength` de
`src/env.ts` e às regras de placeholder do `secret()`); cada variável que o
`src/env.ts` **exige** (declarada sem default — o `DATABASE_URL` com `--prisma`)
e que não está definida nem no ambiente nem no `.env`, como erro com a
correção; um `.env` em falta ao lado de um `.env.example`, como aviso; se o
cliente Prisma está gerado e se existem migrações (se estão *aplicadas* precisa
de uma base de dados — `prisma migrate status`); o `.mcp.json` quando o
`@basaltkit/ai-mcp` está instalado; ferramentas de dev declaradas como
dependência de runtime; um `bin/basalt.ts` ou `src/dev.ts` desatualizado; e,
de forma estática, o caminho de produção — um `start` que corre o tsx quando o tsx
é só devDependency, nenhum script `build`, um `dist/src/server.js` mais antigo do
que o `src/`, um cliente Prisma gerado dentro do `src/` e um
`@prisma/client-runtime-utils` em falta. O `doctor` nunca faz build nem arranca a app.

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

Com a CLI (por omissão, ou depois de acrescentares tu o `@basaltkit/cli` +
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

O código gerado é **seguro por predefinição**. Todas as rotas exigem um
utilizador autenticado (`meta: { auth: true }`), por isso a app recusa arrancar
enquanto nenhum plugin de autenticação o aplicar, e os pedidos anónimos recebem
401. Quando o projeto depende de `@basaltkit/tenancy`, o recurso **pertence ao
tenant**: o repositório restringe cada leitura e escrita com `requireTenantId()`
(sem tenant → `TENANT_REQUIRED`, 400), e o modelo Prisma ganha uma coluna
`tenantId` indexada. O teste gerado autentica-se, verifica que os pedidos
anónimos recebem 401 e, para dados de tenant, que um tenant não vê as linhas de
outro. Uma breve nota de segurança após a geração diz o que se aplica. A
autorização por linha (quem pode ler ou escrever que linhas) continua a ser
contigo.

| Flag do gerador | Aplica-se a | O que faz |
| --- | --- | --- |
| `--prisma` | `make:resource`, `make:repository` | Repositório com Prisma mais um modelo acrescentado ao `schema.prisma` |
| `--soft-delete` | `make:resource` e os artefactos que constrói | Coluna `deletedAt`, `restore()`, rota de restore, leituras filtradas |
| `--dir=<path>` | todos os `make:*` | Raiz de destino (por predefinição, a diretoria atual) |
| `--force` | todos os `make:*` | Sobrescreve ficheiros existentes em vez de recusar |
| `--no-register` | `make:resource` | Salta a ligação automática ao `src/app.ts` |
| `--public` | `make:resource`, `make:routes`, `make:test` | Rotas sem `meta.auth`, abertas a pedidos anónimos (alias `--no-auth`). Usa apenas para um recurso deliberadamente público |
| `--tenant` / `--no-tenant` | `make:resource`, `make:repository`, `make:test` | Força o âmbito por tenant ligado ou desligado (por predefinição: ligado quando o `package.json` depende de `@basaltkit/tenancy`) |
| `--crud` / `--no-crud` | `make:service` | Força o serviço CRUD ou o mínimo (por predefinição: CRUD quando o repositório e o schema irmãos já estão na diretoria de destino) |

Os artefactos individuais estão disponíveis como `make:schema`,
`make:repository`, `make:service`, `make:plugin`, `make:routes` e `make:test`.

### Serviços que não são CRUD

Um serviço CRUD delega num repositório irmão e importa o schema irmão. Gerado
sozinho, onde esses ficheiros não existem, não compilava (`TS2307: Cannot find
module './invoice.repository.js'`) — por isso o `make:service` olha primeiro
para a diretoria de destino:

- `<name>.repository.ts` **e** `<name>.schema.ts` já lá estão (depois de
  `make:resource`, ou escritos por ti) → o serviço CRUD, como antes;
- falta um deles → um **serviço mínimo**: a classe, o seu token de injeção
  `createToken` e um construtor sem dependências, sem importar nada além de
  `@basaltkit/core`. Compila tal como é escrito e traz um TODO a apontar para o
  `make:resource` para a vertical CRUD.

É esta a forma para orquestração, regras de domínio, transações, agendadores —
os serviços que nada têm a ver com um repositório.

```bash
pnpm basalt make:service Billing            # mínimo: não há repositório ao lado
pnpm basalt make:service Invoice --crud     # força a forma CRUD
pnpm basalt make:service Invoice --no-crud  # força a forma mínima
```

O `make:resource` não muda: a vertical recebe sempre o serviço CRUD, porque
gera o repositório e o schema no mesmo lote.

### Um artefacto de cada vez: o aviso dos ficheiros irmãos

O serviço é o único artefacto com uma forma que se aguenta sozinha. Os outros
são membros de uma vertical e importam-se uns aos outros — o plugin precisa do
repositório e do serviço, as rotas precisam do serviço e do schema, o teste
precisa do plugin e das rotas, o repositório precisa do schema. Gerar um deles
sozinho continua a escrever o ficheiro (o irmão pode ser a próxima coisa que
escreves à mão), mas o gerador passa a dizer o que ele referencia e não
encontra:

```
Generated 1 file(s):
  src/modules/invoice/invoice.plugin.ts
Warning: src/modules/invoice/invoice.plugin.ts imports 2 file(s) that do not exist yet:
  src/modules/invoice/invoice.repository.ts
  src/modules/invoice/invoice.service.ts
  Generate the whole vertical with `basalt make:resource Invoice`, or write them yourself — until then this file does not compile.
```

O `make:schema` nunca avisa (não importa nada do módulo) e o `make:resource`
também não (escreve-os todos). Programaticamente, a mesma lista é
`missingSiblings(kind, name, options, { baseDir })`, e
`expectedSiblings(kind, names(name))` é a tabela estática por tipo.

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
| `routes` | As rotas HTTP registadas com as guardas que cada uma declara (`auth`, `can`, `rateLimit`, `tenant`, …), lidas do bucket de metadados `http:routes`. `--json` para saída legível por máquina; `--unguarded --require=auth,can [--allow=<glob,…>]` termina com 1 se houver rotas sem essas guardas — só o meta das rotas, vê [Revisão de segurança das rotas](/pt/guide/security#revisao-de-seguranca-das-rotas-—-basalt-routes) |
| `schedule:list` | Tarefas agendadas com as suas expressões cron e fusos horários |
| `dev` | Imprime a tabela de rotas e corre a app com watch/restart. `--entry=<file>`, `--worker` (`-w`) para arrancar um worker de fila ao lado, `--queue=<name>` |
| `upgrade` | Aplica os codemods de atualização da framework. `--dry` para pré-visualizar, `--only=<id>`, `--dir=<path>` |
| `update`, `add`, `doctor`, `info` | Não são comandos do `runCli`: o `bin/basalt.ts` reencaminha-os para o create-basalt antes de arrancar a app — vê [Atualizar uma app](#atualizar-uma-app) |
| `publish` | Copia um grupo de stubs para a app (`dockerfile` — o build multi-stage + imagem em node puro que o scaffold traz, com um `.dockerignore` que mantém o `.env` e as chaves fora da imagem —, `ci` — install, typecheck, build, test —, `editorconfig`). Corre sem id para listar; `--force` para sobrescrever |

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
| `Unknown command "update"` (+ uma dica do create-basalt) | 1 | O `bin/basalt.ts` é anterior aos comandos de projeto — corre `npx create-basalt@latest update` uma vez; corrige um ficheiro não modificado |
| `No package.json in …` / `… does not look like a Basalt app` | 1 | Um comando de projeto fora de uma app — entra na pasta ou passa `--cwd=<dir>`. Para criar um projeto chamado `update`: `npm create basalt -- --name=update` |
| `Not a terminal — nothing written. Re-run with --yes` | 1 | `update`/`add` sem `--yes` em CI ou num pipe |
| `update resolves the latest versions from the npm registry, so it cannot run with --offline` | 1 | Tira o `--offline`; um mirror funciona através de `npm_config_registry` |
| `The web/ frontend is a pnpm workspace member … this project uses npm` | 1 | `add ui` num projeto que não usa pnpm — muda-o primeiro para pnpm |

- **O scaffolder ignorou as minhas flags** — alguns gestores de pacotes guardam
  para si tudo o que vem depois do nome do pacote. Põe as flags depois de `--`:
  `npm create basalt my-saas -- --billing --cli`. O pnpm e o bun reencaminham-nas
  diretamente.
- **"Skipping dependency install (CI/non-interactive)"** — é esperado: sem uma
  flag explícita, só um terminal interativo fora de CI instala. Passa
  `--install` (e `--git`) para forçar.
- **O `--ui` passou a pnpm sem avisar muito** — tem de ser; o pacote `web/` é
  membro de um workspace pnpm. Arranca o frontend com `pnpm dev:web`
  (= `pnpm --filter <name>-web dev`, porta 5180) enquanto o `pnpm dev` serve a
  API na 3000.
- **"Could not auto-wire src/app.ts"** — o `make:resource` só edita um `app.ts`
  que ainda use `fastifyPlugin({ routes: [...] })`. Acrescenta tu o plugin
  gerado a `plugins` e as rotas ao adaptador; de resto os ficheiros gerados
  estão completos.
- **`The app cannot start — invalid environment variables`** (ou um
  `EnvValidationError … expected string, received undefined` cru numa app mais
  antiga) — uma variável obrigatória não está definida nem na tua shell nem no
  `.env`. As apps do create-basalt ≤ 1.10 nem sequer carregavam o `.env` no
  `pnpm dev` / `pnpm basalt`: corre `npx create-basalt@latest update` uma vez
  (corrige um `bin/basalt.ts` e um `src/dev.ts` intactos), `cp .env.example .env`
  se não houver nenhum, preenche o que a mensagem indica e confirma com
  `pnpm basalt doctor`.
- **`The app cannot start — the database did not answer`** — o PostgreSQL não
  está a correr, ou o `MY_SAAS_DATABASE_URL` aponta para o host/porta errado (a
  mensagem mostra qual, sem credenciais). Arranca-o (`docker compose up -d`, ou o
  teu serviço local) ou corrige o URL no `.env`; numa base de dados nova corre
  `pnpm db:migrate`. **`… the database is not migrated`** — corre
  `pnpm db:migrate` (`pnpm db:deploy` em produção), ou verifica o URL se não for
  a base de dados que querias.
- **A app liga-se à base de dados / porta errada** — uma variável exportada na
  tua shell ganha ao `.env` (tal como ganha ao `--env-file`). Define os nomes com prefixo da app
  (`MY_SAAS_PORT`) que o scaffold declara, não os genéricos. Vê
  [O `--env-file` nunca sobrepõe variáveis exportadas](#o-env-file-nunca-sobrepoe-variaveis-exportadas).
- **O `pnpm basalt …` começa com um `pnpm install`** (ou falha offline) — é o
  `verifyDepsBeforeRun` do pnpm 11. Vê
  [pnpm 11: idade mínima e `verifyDepsBeforeRun`](#pnpm-11-idade-minima-e-verifydepsbeforerun).
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
