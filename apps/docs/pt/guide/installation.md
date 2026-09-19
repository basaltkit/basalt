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
| `--offline` | desativado | Não consulta o registry npm e usa os intervalos de dependências incluídos nesta versão do create-basalt |
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
| `src/server.ts` | Arranca, resolve o `FASTIFY`, escuta e encerra em `SIGINT`/`SIGTERM` |
| `src/dev.ts` | A entrada do `pnpm dev`: define `NODE_ENV=development` se ainda não estiver definido e carrega o `server.ts` |
| `tests/app.test.ts` | Um smoke test que arranca a app e chama `/` e `/health` |
| `package.json` | Scripts `dev` (`tsx watch src/dev.ts`), `start` (`tsx src/server.ts` — um `NODE_ENV` não definido conta como produção), `test`, `typecheck` — mais `basalt` com `--cli`. As versões `@basaltkit/*` seguem a linha de release atual de cada pacote |
| `.env.example`, `.gitignore`, `.dockerignore`, `README.md`, `tsconfig.json`, `pnpm-workspace.yaml` | Estrutura do projeto (o `.dockerignore` mantém o `.env` e as chaves fora das camadas da imagem; o `.env.example` usa os nomes com prefixo da app e, com o README, explica a [armadilha de precedência do `--env-file`](#o-env-file-nunca-sobrepoe-variaveis-exportadas); o `pnpm-workspace.yaml` exclui `@basaltkit/*` do `minimumReleaseAge` e documenta as [definições do pnpm 11](#pnpm-11-idade-minima-e-verifydepsbeforerun)) |
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

### O `--env-file` nunca sobrepõe variáveis exportadas

O `src/env.ts` valida o `process.env` e mais nada — o scaffold não carrega o
`.env` por ti. Quando arrancas com `node --env-file=.env` (ou
`tsx --env-file=.env`), o Node **só preenche as variáveis que ainda não estão
definidas**: um valor exportado na tua shell ganha sempre. Com nomes genéricos
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
| `routes` | As rotas HTTP registadas, lidas do bucket de metadados `http:routes` |
| `schedule:list` | Tarefas agendadas com as suas expressões cron e fusos horários |
| `dev` | Imprime a tabela de rotas e corre a app com watch/restart. `--entry=<file>`, `--worker` (`-w`) para arrancar um worker de fila ao lado, `--queue=<name>` |
| `upgrade` | Aplica os codemods de atualização da framework. `--dry` para pré-visualizar, `--only=<id>`, `--dir=<path>` |
| `publish` | Copia um grupo de stubs para a app (`dockerfile` — com um `.dockerignore` que mantém o `.env` e as chaves fora da imagem —, `ci`, `editorconfig`). Corre sem id para listar; `--force` para sobrescrever |

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
- **A app liga-se à base de dados / porta errada** — uma variável exportada na
  tua shell ganha ao `--env-file`. Define os nomes com prefixo da app
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
