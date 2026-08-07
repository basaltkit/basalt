# @machize/admin

Motor "headless" (sem interface gráfica) para painéis de administração: a partir de um esquema de dados Zod, deriva automaticamente as colunas de uma tabela, os campos de um formulário e as regras de validação. Precisas dele sempre que quiseres construir um painel de administração ("admin") para gerir os dados da tua aplicação — é a base que os pacotes `@machize/admin-react` e `@machize/admin-shadcn` desenham no ecrã.

## O que este módulo resolve

Um **painel de administração** é a área privada de uma aplicação onde a equipa gere os dados: listar clientes, criar projetos, editar produtos, apagar registos. Construir estes ecrãs à mão é repetitivo — para cada tipo de dado tens de escrever uma tabela, um formulário, validação e mensagens de erro, quase sempre com a mesma estrutura.

O `@machize/admin` elimina essa repetição. Descreves os teus dados uma única vez com **Zod** (uma biblioteca popular de validação em TypeScript, onde escreves por exemplo `z.string()` para dizer "este campo é texto"), e o módulo deriva tudo o resto: que colunas mostrar na tabela, que campos aparecem no formulário, quais são obrigatórios, e como validar o que o utilizador escreve.

A palavra **headless** significa que este pacote não desenha nada no ecrã — não tem HTML nem componentes visuais. Ele apenas produz "modelos de vista" (estruturas de dados que descrevem o que deve aparecer). Quem transforma isso em ecrãs reais são os pacotes irmãos: `@machize/admin-react` (HTML simples) e `@machize/admin-shadcn` (com estilo shadcn/ui). Esta separação permite trocar de aspeto visual sem reescrever a lógica.

## Instalação

```bash
pnpm add @machize/admin zod
```

> O `zod` é uma *peer dependency* (dependência que tens de instalar tu próprio, para garantir que só existe uma versão no projeto). São suportadas as versões 3.24+ e 4.x.

## Começar em 5 minutos

Vamos criar um recurso "projects" (projetos) e ver o que o módulo deriva sozinho.

**Passo 1 — Descreve os teus dados com Zod.** Um *schema* (esquema) é a descrição da forma dos dados:

```ts
import { z } from 'zod'

// Como é um projeto guardado na base de dados:
const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['draft', 'published']), // só admite estes dois valores
  archived: z.boolean().optional(),       // opcional
})

// O que é preciso para CRIAR um projeto (sem id — é gerado pelo sistema):
const CreateProjectSchema = z.object({
  name: z.string().min(3), // nome com pelo menos 3 caracteres
  status: z.enum(['draft', 'published']),
})
```

**Passo 2 — Define o recurso.** Um *recurso* é uma entidade que o painel gere (projetos, clientes, produtos…):

```ts
import { defineResource } from '@machize/admin'

const projects = defineResource({
  name: 'projects',
  schema: ProjectSchema,
  createSchema: CreateProjectSchema,
  columns: ['name', 'status'], // colunas a mostrar na tabela, por esta ordem
})
```

**Passo 3 — Vê o que foi derivado automaticamente:**

```ts
console.log(projects.label)
// 'Projects' (nome humanizado, gerado a partir de 'projects')

console.log(projects.columns().map((c) => c.label))
// ['Name', 'Status']

console.log(projects.formFields().map((f) => `${f.label} (${f.type})`))
// ['Name (string)', 'Status (enum)']
```

**Passo 4 — Valida dados introduzidos pelo utilizador:**

```ts
const ok = projects.validate({ name: 'Machize', status: 'draft' })
console.log(ok) // { success: true, data: { name: 'Machize', status: 'draft' } }

const mau = projects.validate({ name: 'ab', status: 'nope' })
console.log(mau.errors)
// { name: 'String must contain at least 3 character(s)', status: '...' }
// Uma mensagem por campo — pronta a mostrar debaixo de cada input.
```

**Passo 5 — Experimenta com dados em memória** (sem base de dados):

```ts
import { memoryDataSource } from '@machize/admin'

const source = memoryDataSource<{ id: string; name: string }>([
  { id: 'p1', name: 'Apollo' },
])

await source.create({ name: 'Nova' })          // gera um id automaticamente
console.log(await source.list())               // 2 registos
console.log(await source.list({ search: 'apo' })) // pesquisa livre → [Apollo]
```

## Guia de utilização

### Derivar campos de um schema — `fieldsFromSchema`

É o coração do pacote: recebe um schema Zod e devolve um descritor por cada campo (nome, etiqueta legível, tipo, obrigatoriedade, opções de enum). Wrappers como `.optional()`, `.nullable()` e `.default()` são "desembrulhados" e tornam o campo não obrigatório.

```ts
import { z } from 'zod'
import { fieldsFromSchema } from '@machize/admin'

const fields = fieldsFromSchema(
  z.object({
    name: z.string(),
    priority: z.number().default(0),
    dueAt: z.date().nullable(),
    status: z.enum(['draft', 'published']),
  }),
)
// [
//   { name: 'name', label: 'Name', type: 'string', required: true },
//   { name: 'priority', label: 'Priority', type: 'number', required: false },
//   { name: 'dueAt', label: 'Due At', type: 'date', required: false },
//   { name: 'status', label: 'Status', type: 'enum', required: true,
//     options: ['draft', 'published'] },
// ]
```

### Etiquetas legíveis — `humanize`

Converte nomes técnicos em texto apresentável:

```ts
import { humanize } from '@machize/admin'

humanize('createdAt')       // 'Created At'
humanize('blog_post_title') // 'Blog Post Title'
humanize('due-date')        // 'Due Date'
```

### Recursos — `defineResource` e a classe `Resource`

O `Resource` junta os schemas e responde às perguntas que a interface faz: que colunas? que campos no formulário? este input é válido?

```ts
import { z } from 'zod'
import { defineResource } from '@machize/admin'

const tags = defineResource({
  name: 'tags',
  schema: z.object({ id: z.string(), label: z.string() }),
})

// Sem createSchema, o formulário usa os campos da entidade MENOS o id:
tags.formFields().map((f) => f.name) // ['label']

// Sem schema de validação, validate aceita tudo:
tags.validate({ label: 'x' }) // { success: true, data: { label: 'x' } }
```

Modos de formulário: `'create'` usa `createSchema`; `'update'` usa `updateSchema` (ou, se não existir, o `createSchema`).

### Modelos de vista — `tableView` e `formView`

Estas funções produzem objetos simples que uma camada visual (React ou outra) desenha:

```ts
import { tableView, formView } from '@machize/admin'

const table = tableView(projects, [{ id: 'p1', name: 'A', status: 'draft' }])
// { columns: [...campos...], rows: [...linhas...] }

const form = formView(projects, { name: 'A' }, 'create')
// { fields: [...campos...], values: { name: 'A' }, mode: 'create' }
```

### Fonte de dados — `AdminDataSource` e `memoryDataSource`

`AdminDataSource` é o **contrato** (interface TypeScript) que liga o painel aos teus dados reais: cinco operações CRUD (`list`, `get`, `create`, `update`, `remove`). Implementa-o sobre a tua API — tipicamente com o cliente do `@machize/sdk`:

```ts
import type { AdminDataSource } from '@machize/admin'

type Project = { id: string; name: string; status: string }

// Exemplo: adaptador sobre uma API HTTP qualquer
const apiSource: AdminDataSource<Project> = {
  async list(params) {
    const query = params?.search ? `?search=${encodeURIComponent(params.search)}` : ''
    return (await fetch(`/api/projects${query}`)).json()
  },
  async get(id) {
    const res = await fetch(`/api/projects/${id}`)
    return res.ok ? res.json() : null
  },
  async create(input) {
    return (await fetch('/api/projects', { method: 'POST', body: JSON.stringify(input) })).json()
  },
  async update(id, input) {
    const res = await fetch(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) })
    return res.ok ? res.json() : null
  },
  async remove(id) {
    return (await fetch(`/api/projects/${id}`, { method: 'DELETE' })).ok
  },
}
```

Para testes e protótipos usa `memoryDataSource(seed)` — guarda tudo em memória, suporta pesquisa livre em campos de texto e paginação com `{ page, pageSize }`.

## Referência da API

### `defineResource(config): Resource`

Cria um `Resource` a partir de um `ResourceConfig`:

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `name` | `string` | Sim | — | Nome máquina no plural, ex.: `'projects'`. |
| `label` | `string` | Não | `humanize(name)` | Nome apresentável. |
| `schema` | `z.ZodObject` | Sim | — | Schema da entidade — determina as colunas da tabela. |
| `createSchema` | `z.ZodObject` | Não | — | Schema de criação — determina o formulário e a validação. |
| `updateSchema` | `z.ZodObject` | Não | `createSchema` | Schema de edição. |
| `columns` | `string[]` | Não | todos os campos | Subconjunto ordenado de campos a mostrar na tabela. |
| `idField` | `string` | Não | `'id'` | Nome do campo identificador. |

### Classe `Resource`

| Membro | Assinatura | Descrição |
|---|---|---|
| `name` | `string` | Nome máquina. |
| `label` | `string` | Nome apresentável. |
| `idField` | `string` | Campo identificador. |
| `fields()` | `() => Field[]` | Todos os campos da entidade. |
| `columns()` | `() => Field[]` | Colunas da tabela (respeita `columns` do config). |
| `formFields(mode?)` | `(mode?: FormMode) => Field[]` | Campos do formulário para o modo (`'create'` por omissão); sem schema do modo, usa os campos da entidade menos o id. |
| `validate(input, mode?)` | `(input: unknown, mode?: FormMode) => ValidationResult` | Valida contra o schema do modo; sem schema, devolve sucesso. |

### `fieldsFromSchema(schema): Field[]`

Deriva `Field[]` de um `z.ZodObject`. Tipos reconhecidos: `ZodString → 'string'`, `ZodNumber → 'number'`, `ZodBoolean → 'boolean'`, `ZodDate → 'date'`, `ZodEnum → 'enum'` (com `options`); qualquer outro → `'unknown'`.

### `humanize(name): string`

Converte `camelCase`, `snake_case` e `kebab-case` em "Title Case" com espaços.

### `tableView(resource, rows): TableView`

Devolve `{ columns: Field[], rows: Record<string, unknown>[] }`.

### `formView(resource, values?, mode?): FormView`

Devolve `{ fields: Field[], values, mode }`. Defaults: `values = {}`, `mode = 'create'`.

### `memoryDataSource<T>(seed?): AdminDataSource<T>`

Fonte de dados em memória (`T` tem de ter `id: string`). `list` suporta `search` (texto livre, apenas campos string), `page` e `pageSize`. `create` gera um UUID se o input não trouxer `id`. `update`/`get` devolvem `null` quando o id não existe; `remove` devolve `false`.

### Tipos exportados

| Tipo | Forma | Descrição |
|---|---|---|
| `Field` | `{ name, label, type, required, options? }` | Descritor de campo/coluna. |
| `FieldType` | `'string' \| 'number' \| 'boolean' \| 'date' \| 'enum' \| 'unknown'` | Tipo lógico do campo. |
| `FormMode` | `'create' \| 'update'` | Modo do formulário. |
| `ValidationResult` | `{ success, data?, errors? }` | `errors` tem uma mensagem por campo, indexada pelo nome. |
| `TableView` | `{ columns, rows }` | Modelo de vista da tabela. |
| `FormView` | `{ fields, values, mode }` | Modelo de vista do formulário. |
| `AdminDataSource<T>` | `{ list, get, create, update, remove }` | Contrato CRUD da fonte de dados. |
| `ListParams` | `{ page?, pageSize?, search? }` | Parâmetros de listagem. |
| `ResourceConfig` | ver tabela acima | Configuração do recurso. |

## Erros comuns e soluções (FAQ)

**"Os meus campos aparecem com type `'unknown'`."** O campo usa um tipo Zod não reconhecido (ex.: `z.array()`, `z.object()` aninhado, `z.union()`). Só são classificados `string`, `number`, `boolean`, `date` e `enum`. Para os restantes, trata a apresentação na tua camada visual.

**"O formulário mostra o campo `id` e eu não quero."** Isso acontece quando não defines `createSchema`. Ou defines um `createSchema` sem o id, ou confirma que o teu campo identificador se chama `id` (ou ajusta `idField`) — o fallback remove apenas o campo `idField`.

**"O `validate` aceita tudo!"** Sem `createSchema`/`updateSchema` não há regras para aplicar — `validate` devolve sempre sucesso. Define um schema de input para teres validação.

**"Um campo com `.default()` aparece como não obrigatório."** É intencional: se tem valor por omissão, o utilizador não é obrigado a preenchê-lo.

**"O `memoryDataSource` perde os dados."** É mesmo só memória — reiniciar o processo apaga tudo. Serve para testes e demos; em produção implementa `AdminDataSource` sobre a tua API.

**"Erro `Cannot find module 'zod'`."** O `zod` é peer dependency: `pnpm add zod`.

## Como se liga aos outros módulos

- **`@machize/admin-react`** — desenha `Resource` no ecrã com HTML simples: `DataTable`, `ResourceForm` e o hook `useList` consomem diretamente `tableView`, `formView` e `AdminDataSource` deste pacote.
- **`@machize/admin-shadcn`** — o mesmo papel, mas com componentes estilizados shadcn/ui (Tailwind CSS). É o pacote usado pelo scaffold `create-machize --ui`.
- **`@machize/dashboard`** — usa `Resource` nas suas `resourceSection` para montar a navegação de um painel completo, e junta métricas de faturação, filas e auditoria.
- **`@machize/sdk`** — o cliente HTTP tipado do Machize; é a forma natural de implementar `AdminDataSource` contra um backend Machize real (Fastify/Express/Hono).
