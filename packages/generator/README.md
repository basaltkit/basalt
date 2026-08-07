# @machize/generator

Gerador de código ("scaffolding") para aplicações Machize: os comandos `mach make:*` criam por ti todos os ficheiros de um recurso — schema, repositório, serviço, plugin, rotas HTTP e teste — já interligados e a compilar. Precisas dele sempre que fores adicionar uma nova "entidade" à aplicação (Projetos, Clientes, Faturas…) e não quiseres escrever o mesmo esqueleto à mão.

## O que este módulo resolve

**Scaffolding** (ou "gerar andaimes") é a prática de criar automaticamente os ficheiros repetitivos de uma funcionalidade nova. Numa aplicação bem organizada, cada recurso (por exemplo "Project") costuma precisar sempre das mesmas peças: um **schema** (a descrição validada dos dados, feita com Zod), um **repositório** (a camada que guarda e lê os dados), um **serviço** (a lógica de negócio), um **plugin** (que regista tudo no contentor de dependências), as **rotas HTTP** (os endpoints REST) e um **teste**.

Escrever estas seis peças à mão para cada recurso é lento e propenso a erros de nomes — basta trocar `blogPost` por `blogpost` num sítio e nada compila. O gerador deriva todas as variações do nome de uma só vez (`BlogPost`, `blogPost`, `blog-post`, `blog-posts`, `BLOG_POST`) e usa-as de forma consistente em todos os ficheiros.

Além de gerar os ficheiros, o `make:resource` ainda liga o recurso novo ao `src/app.ts` automaticamente (importa o plugin e as rotas e insere-os nos sítios certos) e, com `--prisma`, gera um repositório ligado à base de dados via Prisma em vez da versão em memória.

## Instalação

```bash
pnpm add @machize/generator
```

> Nota: depende de `@machize/cli` (o framework de comandos `mach`). O código gerado usa `@machize/core`, `@machize/fastify`, `zod` e — nos testes gerados — `@machize/testing`, por isso convém tê-los no projeto. Se criaste o projeto com `create-machize --cli`, está tudo pronto.

## Começar em 5 minutos

1. Garante que a tua aplicação regista os comandos do gerador. Em `src/app.ts`:

```typescript
import { createApp } from '@machize/core'
import { commandsPlugin } from '@machize/cli'
import { fastifyPlugin } from '@machize/fastify'
import { generatorCommands } from '@machize/generator'
import { appRoutes } from './routes.js'

export function buildApp() {
  return createApp({
    plugins: [
      commandsPlugin(generatorCommands()),
      fastifyPlugin({ routes: [...appRoutes] }),
    ],
  })
}
```

2. Garante que tens o executável `mach` (criado automaticamente pelo `create-machize --cli`; ver o README do `@machize/cli` se não tiveres).

3. Gera um recurso completo:

```bash
pnpm mach make:resource Project
```

4. Vê o que foi criado:

```
Generated 6 file(s):
  src/modules/project/project.plugin.ts
  src/modules/project/project.repository.ts
  src/modules/project/project.routes.ts
  src/modules/project/project.schema.ts
  src/modules/project/project.service.ts
  tests/project.test.ts
Wired the plugin + routes into src/app.ts.
```

5. Corre os testes e experimenta os endpoints:

```bash
pnpm test          # o teste gerado cobre criar/listar/obter/atualizar/apagar
pnpm dev           # GET/POST /projects, GET/PATCH/DELETE /projects/:id
```

## Guia de utilização

### `mach make:resource <Nome>` — o recurso completo

Gera a "vertical" inteira: schema → repositório → serviço → plugin → rotas → teste. Por omissão, o repositório é **em memória** (os dados perdem-se ao reiniciar — ótimo para começar) e o recurso é ligado ao `src/app.ts` automaticamente.

```bash
pnpm mach make:resource BlogPost
```

O nome pode vir em qualquer formato — `BlogPost`, `blog-post`, `blog post` — o gerador normaliza. Os endpoints usam o plural em kebab-case: `/blog-posts`.

Opções (comuns a todos os comandos `make:*`, salvo indicação):

| Flag | O que faz |
| --- | --- |
| `--dir=<caminho>` | Raiz do projeto onde escrever (default: diretório atual) |
| `--force` | Substitui ficheiros existentes em vez de recusar |
| `--prisma` | Gera um repositório ligado ao Prisma + um modelo para o `schema.prisma` |
| `--no-register` | (só `make:resource`) Não mexe no `src/app.ts` |

### `--prisma` — persistência real com base de dados

```bash
pnpm mach make:resource BlogPost --prisma
```

Em vez do repositório em memória, gera `PrismaBlogPostRepository` (que usa `db()` de `@machize/prisma`) e um ficheiro extra `src/modules/blog-post/blog-post.prisma` com o bloco de modelo para copiares para o teu `schema.prisma`. Depois corre `prisma migrate dev`.

### Ligação automática ao `src/app.ts`

Depois de escrever os ficheiros, o `make:resource` tenta:

1. adicionar os `import` do plugin e das rotas a seguir ao último import;
2. inserir `blogPostPlugin,` imediatamente antes de `fastifyPlugin(`;
3. espalhar `...blogPostRoutes, ` no início do array `fastifyPlugin({ routes: [...] })`.

É **idempotente** (correr duas vezes não duplica nada) e **tudo-ou-nada**: se o `src/app.ts` não existir, já estiver ligado, ou não tiver a forma `fastifyPlugin({ routes: [...] })`, não altera nada e explica porquê — nesse caso fazes a ligação à mão.

### Gerar apenas uma peça: `make:schema`, `make:repository`, …

Cada tipo de artefacto tem o seu comando:

```bash
pnpm mach make:schema Invoice        # src/modules/invoice/invoice.schema.ts
pnpm mach make:repository Invoice    # src/modules/invoice/invoice.repository.ts
pnpm mach make:service Invoice       # src/modules/invoice/invoice.service.ts
pnpm mach make:plugin Invoice        # src/modules/invoice/invoice.plugin.ts
pnpm mach make:routes Invoice        # src/modules/invoice/invoice.routes.ts
pnpm mach make:test Invoice          # tests/invoice.test.ts
```

Sem nome, qualquer comando imprime a utilização e devolve o código 1:

```
Usage: mach make:resource <Name> [--dir=<path>] [--force] [--prisma]
```

### Usar o gerador como biblioteca (Avançado)

Podes gerar ficheiros por programa, sem passar pela CLI:

```typescript
import { generateResource, writeGenerated, registerResourceInApp } from '@machize/generator'

const files = generateResource('BlogPost', { prisma: false })
const written = await writeGenerated(files, { baseDir: '/caminho/do/projeto' })
console.log(written) // caminhos relativos, ordenados

const result = await registerResourceInApp('BlogPost', { baseDir: '/caminho/do/projeto' })
console.log(result.registered) // true se ligou ao src/app.ts
```

## Referência da API

Exportado a partir de `@machize/generator`:

### `names(input: string): Names`

Deriva todas as variações de um nome. Lança `Error` se não conseguir extrair palavras do input.

| Campo de `Names` | Exemplo (`blog-post`) | Uso |
| --- | --- | --- |
| `raw` | `blog-post` | Input original |
| `pascal` | `BlogPost` | Nomes de classes e tipos |
| `camel` | `blogPost` | Variáveis e identificadores |
| `kebab` | `blog-post` | Nomes de ficheiros e pastas |
| `pluralKebab` | `blog-posts` | Caminhos das rotas |
| `constant` | `BLOG_POST` | Tokens e códigos de erro |

A pluralização é inglesa e simplificada (`company` → `companies`, `box` → `boxes`, resto → `+s`).

### `generate(kind, name, options?): GeneratedFile`

Gera **um** artefacto. `kind` é um `GeneratorKind`: `'schema' | 'repository' | 'service' | 'plugin' | 'routes' | 'test'`.

### `generateResource(name, options?): GeneratedFile[]`

Gera a vertical completa. Com `options.prisma: true` acrescenta o ficheiro `.prisma` e troca o repositório para a versão Prisma.

`GeneratorOptions`:

| Campo | Tipo | Obrigatório? | Default | Descrição |
| --- | --- | --- | --- | --- |
| `prisma` | `boolean` | Não | `false` | Repositório Prisma (+ modelo `schema.prisma`) em vez de em memória |

`GeneratedFile`: `{ path: string; content: string }` — o caminho é relativo à raiz do projeto.

### `writeGenerated(files, options?): Promise<string[]>`

Escreve os ficheiros no disco (cria as pastas necessárias). Devolve os caminhos escritos, ordenados. Se algum ficheiro já existir e `force` for falso, lança `FileExistsError` **antes** de escrever qualquer coisa.

`WriteOptions`:

| Campo | Tipo | Obrigatório? | Default | Descrição |
| --- | --- | --- | --- | --- |
| `baseDir` | `string` | Não | `process.cwd()` | Raiz do projeto contra a qual os caminhos são resolvidos |
| `force` | `boolean` | Não | `false` | Substituir ficheiros existentes |

### `registerResourceInApp(name, options?): Promise<AppRegistration>`

Liga um recurso gerado ao `src/app.ts` (imports + plugin + spread das rotas). Nunca lança por causa da forma do ficheiro — reporta o motivo.

`AppRegistration`:

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `registered` | `boolean` | `true` se alterou o ficheiro |
| `reason` | `string?` | Quando não regista: `'src/app.ts not found'`, `'already registered'` ou `'app.ts does not use fastifyPlugin({ routes: [...] })'` |
| `appPath` | `string` | Caminho absoluto do `src/app.ts` considerado |

### `generatorCommands(): CommandDefinition[]`

Devolve os comandos `make:resource` e `make:<kind>` (um por cada `GeneratorKind`) prontos a registar com `commandsPlugin` de `@machize/cli`.

### `GENERATORS` (Avançado)

Mapa `kind → função geradora` (`{ schema, repository, service, plugin, routes, test }`). `GeneratorKind` é `keyof typeof GENERATORS`.

### `FileExistsError`

Erro lançado por `writeGenerated` quando há conflitos sem `force`. Tem a propriedade `paths: string[]` com os ficheiros em conflito.

### Tipos exportados

`Names`, `GeneratedFile`, `GeneratorKind`, `GeneratorOptions`, `WriteOptions`, `AppRegistration` — descritos acima.

## Erros comuns e soluções (FAQ)

**`Refusing to overwrite existing files (use force to replace): …`**
O gerador nunca substitui ficheiros por omissão. Se queres mesmo regenerar, acrescenta `--force` (na CLI) ou `{ force: true }` (na API). Atenção: perdes as alterações manuais nesses ficheiros.

**`Could not auto-wire src/app.ts (app.ts does not use fastifyPlugin({ routes: [...] })).`**
A ligação automática só reconhece a forma `fastifyPlugin({ routes: [...] })` em `src/app.ts`. Se reorganizaste o ficheiro, faz a ligação à mão: importa `<nome>Plugin` e `<nome>Routes` do módulo gerado, adiciona o plugin à lista `plugins` e espalha as rotas (`...<nome>Routes`) no array `routes`.

**Gerei com `--prisma` mas dá erro `blogPost` não existe no PrismaClient.**
O repositório Prisma assume um modelo com o nome PascalCase (`model BlogPost`) no teu `schema.prisma`. Copia o conteúdo do ficheiro `.prisma` gerado para o `schema.prisma`, corre `prisma migrate dev` e volta a gerar o cliente Prisma.

**Os dados desaparecem quando reinicio o servidor.**
É o comportamento esperado do repositório em memória (o default). Para persistência real, gera com `--prisma` ou implementa tu a interface `<Nome>Repository` e regista-a no plugin.

**`Usage: mach make:resource <Name> …` e código de saída 1.**
Faltou o nome do recurso: `pnpm mach make:resource Project`.

**Corri `make:resource` duas vezes e o `app.ts` não mudou à segunda.**
Correto — a ligação é idempotente. A mensagem `Already wired into src/app.ts — left it as is.` confirma que nada foi duplicado.

## Como se liga aos outros módulos

- **`@machize/cli`** — dependência direta: `generatorCommands()` devolve `CommandDefinition[]` para registares com `commandsPlugin`; é o que faz os `make:*` aparecerem no `mach`.
- **`@machize/core`** — o código gerado usa `createToken`, `definePlugin` e `ctx` do núcleo do framework.
- **`@machize/fastify`** — as rotas geradas usam `route(...)` e `HttpError`; a ligação automática procura `fastifyPlugin({ routes: [...] })` no `app.ts`.
- **`@machize/prisma`** — com `--prisma`, o repositório gerado usa `db()` deste pacote.
- **`@machize/testing`** — o teste gerado usa `createTestApp` para exercitar o CRUD completo.
- **`create-machize`** — com `--cli`, o projeto novo já vem com `@machize/generator` instalado e os comandos registados.
