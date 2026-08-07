# @machize/cli

Framework de comandos de terminal (o comando `mach`) para aplicações Machize: permite definir os teus próprios comandos, executá-los contra a aplicação já arrancada e inspecionar rotas HTTP e tarefas agendadas. Precisas dele quando quiseres dar à tua aplicação uma "linha de comandos" própria — por exemplo `mach routes` ou `mach db:seed`.

## O que este módulo resolve

Uma **CLI** (Command Line Interface, ou "interface de linha de comandos") é a forma de interagir com um programa escrevendo comandos num terminal, em vez de clicar em botões. Quase todas as aplicações de servidor precisam de tarefas administrativas que não fazem sentido como páginas web: listar as rotas registadas, correr migrações, semear a base de dados, etc.

O problema é que essas tarefas normalmente precisam da aplicação "viva": com a base de dados ligada, os plugins registados e a configuração carregada. Escrever um script solto para cada tarefa obriga a repetir todo esse arranque manualmente.

O `@machize/cli` resolve isto: tu descreves cada comando com `defineCommand`, registas os comandos com o plugin `commandsPlugin`, e o `runCli` trata do resto — arranca a aplicação, interpreta os argumentos do terminal, executa o comando certo e desliga tudo no fim. Traz ainda dois comandos incluídos de fábrica (`routes` e `schedule:list`) e utilitários para testar comandos sem imprimir nada no ecrã.

## Instalação

```bash
pnpm add @machize/cli
```

> Nota: o pacote depende de `@machize/core` (o coração do framework, onde vivem `createApp` e o contentor de dependências). Se criaste o projeto com `create-machize --cli`, ambos já estão instalados.

## Começar em 5 minutos

1. Cria um ficheiro `bin/mach.ts` na raiz do projeto — este será o ponto de entrada do comando `mach`:

```typescript
#!/usr/bin/env node
import { runCli } from '@machize/cli'
import { buildApp } from '../src/app.js'

const app = buildApp({ logLevel: 'silent' })
process.exit(await runCli({ app }))
```

2. Define um comando teu, por exemplo em `src/commands/greet.ts`:

```typescript
import { defineCommand } from '@machize/cli'

export const greetCommand = defineCommand({
  name: 'greet',
  description: 'Cumprimenta alguém',
  handle({ args, io }) {
    io.log(`Olá, ${args[0] ?? 'mundo'}!`)
  },
})
```

3. Regista o comando na aplicação (em `src/app.ts`), dentro da lista de plugins:

```typescript
import { createApp } from '@machize/core'
import { commandsPlugin } from '@machize/cli'
import { greetCommand } from './commands/greet.js'

export function buildApp() {
  return createApp({
    plugins: [commandsPlugin([greetCommand])],
  })
}
```

4. Adiciona um atalho no `package.json`:

```json
{
  "scripts": {
    "mach": "tsx bin/mach.ts"
  }
}
```

5. Executa no terminal:

```bash
pnpm mach list          # mostra todos os comandos disponíveis
pnpm mach greet Maria   # imprime: Olá, Maria!
```

## Guia de utilização

### Comandos incluídos de fábrica

Sem registares nada, o `runCli` disponibiliza sempre:

| Comando | O que faz |
| --- | --- |
| `mach list` (ou `mach` sem argumentos) | Lista todos os comandos disponíveis, com as descrições |
| `mach routes` | Lista as rotas HTTP registadas pela aplicação (lidas do balde de metadados `http:routes`, preenchido pelos adaptadores HTTP como o `@machize/fastify`) |
| `mach schedule:list` | Lista as tarefas agendadas e as respetivas expressões cron (lidas do balde `schedule:entries`, preenchido pelo `@machize/scheduler`) |

Se instalares também o `@machize/generator`, ganhas os comandos `make:*` (ver a secção "Como se liga aos outros módulos").

### Definir um comando com argumentos e flags

Os **argumentos posicionais** são as palavras soltas depois do nome do comando; as **flags** são opções no formato `--nome` ou `--nome=valor`. O parser é simples e previsível:

- `--fresh` → `flags.fresh === true` (booleano)
- `--step=2` → `flags.step === '2'` (texto — converte tu para número se precisares)

```typescript
import { defineCommand } from '@machize/cli'

export const migrateCommand = defineCommand({
  name: 'tenant:migrate',
  description: 'Migra a base de dados de um tenant',
  async handle({ args, flags, container, io }) {
    const tenantId = args[0]
    if (!tenantId) {
      io.error('Utilização: mach tenant:migrate <tenantId> [--fresh] [--step=N]')
      return 1 // código de saída ≠ 0 sinaliza erro ao terminal
    }
    const fresh = flags['fresh'] === true
    const step = typeof flags['step'] === 'string' ? Number(flags['step']) : undefined

    io.log(`A migrar ${tenantId} (fresh=${fresh}, step=${step ?? 'todos'})…`)
    // usa container.get(TOKEN) para obter serviços da aplicação
    return 0
  },
})
```

Convenção de nomes: `substantivo:verbo`, por exemplo `tenant:migrate`, `db:seed`.

### Testar comandos sem imprimir no ecrã

O `memoryIo()` captura tudo o que o comando imprimiria, para poderes verificar em testes (exemplo real da suite de testes do pacote):

```typescript
import { describe, expect, it } from 'vitest'
import { createApp } from '@machize/core'
import { commandsPlugin, defineCommand, memoryIo, runCli } from '@machize/cli'

it('executa o comando greet', async () => {
  const io = memoryIo()
  const app = createApp({
    plugins: [
      commandsPlugin([
        defineCommand({
          name: 'greet',
          handle: ({ args, io }) => io.log(`Olá, ${args[0]}!`),
        }),
      ]),
    ],
  })

  const code = await runCli({ app, argv: ['greet', 'mundo', '--loud'], io })
  expect(code).toBe(0)
  expect(io.lines).toEqual(['Olá, mundo!'])
})
```

## Referência da API

Tudo o que o pacote exporta a partir de `@machize/cli`:

### `defineCommand(command)`

Função identidade com tipagem — devolve a definição tal e qual, apenas garante que o objeto tem a forma correta.

`CommandDefinition`:

| Campo | Tipo | Obrigatório? | Default | Descrição |
| --- | --- | --- | --- | --- |
| `name` | `string` | Sim | — | Nome do comando; convenção `substantivo:verbo` |
| `description` | `string` | Não | — | Descrição mostrada em `mach list` |
| `handle` | `(context) => void \| number \| Promise<void \| number>` | Sim | — | A função executada; devolve o código de saída (omitir = 0) |

`CommandContext` (o objeto recebido por `handle`):

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `app` | `MachizeApp` | A aplicação (já arrancada) |
| `container` | `Container` | O contentor de dependências — usa `container.get(TOKEN)` para obter serviços |
| `io` | `CommandIo` | Superfície de escrita (`log`, `error`, `table`) |
| `args` | `string[]` | Argumentos posicionais depois do nome do comando |
| `flags` | `Record<string, string \| boolean>` | Flags: `--key=value` → string, `--flag` → `true` |

### `runCli(options): Promise<number>`

Arranca a aplicação (se ainda estiver na fase `created`), resolve o comando (incluídos + registados no balde de metadados `commands`), executa-o e desliga a aplicação no fim (`app.shutdown()`, mesmo em caso de erro). Devolve o código de saída em vez de chamar `process.exit` — quem chama decide o que fazer com ele.

`RunCliOptions`:

| Campo | Tipo | Obrigatório? | Default | Descrição |
| --- | --- | --- | --- | --- |
| `app` | `MachizeApp` | Sim | — | A aplicação criada com `createApp` |
| `argv` | `string[]` | Não | `process.argv.slice(2)` | Argumentos a interpretar |
| `io` | `CommandIo` | Não | `consoleIo()` | Superfície de escrita — troca por `memoryIo()` em testes |

Comportamento: sem comando (ou `list`) mostra a tabela de comandos e devolve `0`; comando desconhecido imprime erro e devolve `1`; caso contrário devolve o código do comando (`?? 0`).

### `commandsPlugin(commands: CommandDefinition[])`

Plugin Machize que regista os comandos no balde de metadados `'commands'`, onde o `runCli` os vai buscar. Passa-o na lista `plugins` de `createApp`.

### `parseArgv(argv: string[]): ParsedArgv`

Parser mínimo de argumentos: a primeira palavra "solta" é o comando; `--key=value` e `--flag` tornam-se flags. Devolve `{ command: string | undefined, args: string[], flags: Record<string, string | boolean> }`.

### `consoleIo(): CommandIo`

Implementação de `CommandIo` que escreve na consola (`console.log` / `console.error`; `table` desenha via `renderTable`). É o default de `runCli`.

### `memoryIo(): CommandIo & { lines: string[]; errors: string[] }`

Implementação em memória para testes: acumula as mensagens em `lines` e `errors` em vez de imprimir.

### `renderTable(rows: Record<string, unknown>[]): string`

Desenha as linhas como uma tabela de texto alinhada, sem dependências externas. Com lista vazia devolve `'(empty)'`. Células `undefined`/`null` ficam em branco.

### `builtinCommands(): CommandDefinition[]`

Devolve `[routesCommand, scheduleListCommand]`. *(Avançado — o `runCli` já os inclui automaticamente.)*

### `routesCommand` / `scheduleListCommand`

As definições dos comandos incluídos `routes` e `schedule:list`. *(Avançado — úteis apenas se quiseres executá-los diretamente ou compor a tua própria lista.)*

### Tipos exportados

| Tipo | Descrição |
| --- | --- |
| `CommandDefinition`, `CommandContext`, `CommandIo` | Descritos acima |
| `RunCliOptions`, `ParsedArgv` | Descritos acima |
| `RouteMetadata` | `{ method: string; url: string; [key: string]: unknown }` — entradas do balde `http:routes` |
| `ScheduleMetadata` | `{ name: string; cron: string; timezone: string }` — entradas do balde `schedule:entries` |

## Erros comuns e soluções (FAQ)

**`Unknown command "x". Run "mach list" to see what is available.`**
O comando não está registado. Confirma que o passaste dentro de `commandsPlugin([...])` e que esse plugin está na lista `plugins` de `createApp`. Corre `mach list` para veres o que existe.

**O meu comando corre mas a flag `--step 2` não funciona.**
O parser só reconhece o formato com sinal de igual: `--step=2`. Escrito com espaço, `2` é tratado como argumento posicional (aparece em `args`).

**`mach routes` diz "No routes registered."**
O comando lê o balde de metadados `http:routes`, que é preenchido pelo adaptador HTTP (por exemplo `fastifyPlugin`). Garante que o adaptador está registado na mesma aplicação que passas ao `runCli`.

**A aplicação fica "pendurada" depois do comando terminar.**
O `runCli` chama sempre `app.shutdown()` no fim. Se algo continua vivo, é provavelmente um recurso aberto fora do ciclo de vida da aplicação (um `setInterval` teu, por exemplo) — fecha-o no próprio comando.

**Quero um código de saída de erro personalizado.**
Devolve um número no `handle` (por exemplo `return 3`). O `runCli` propaga-o; o `bin/mach.ts` do exemplo passa-o a `process.exit`.

## Como se liga aos outros módulos

- **`@machize/core`** — dependência direta: o `runCli` recebe uma `MachizeApp` de `createApp`, e os comandos acedem ao `Container` e aos baldes de metadados (`ensureMetadata`).
- **`@machize/generator`** — fornece `generatorCommands()`, uma lista de comandos `make:*` (geradores de código) pronta a passar ao `commandsPlugin`. É assim que `mach make:resource` aparece.
- **`@machize/fastify`** — escreve as rotas no balde `http:routes`, que o comando incluído `routes` lê.
- **`@machize/scheduler`** — escreve as tarefas no balde `schedule:entries`, que `schedule:list` lê.
- **`create-machize`** — com a flag `--cli`, o gerador de projetos cria o `bin/mach.ts`, o script `pnpm mach` e regista `commandsPlugin(generatorCommands())` por ti.
