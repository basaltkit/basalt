# @machize/admin-react

Componentes React prontos a usar para o motor `@machize/admin`: uma tabela (`DataTable`) e um formulário (`ResourceForm`) gerados automaticamente a partir dos teus schemas Zod, mais um hook (`useList`) para carregar dados. Precisas dele quando queres pôr um painel de administração no ecrã com React, sem escrever tabelas e formulários à mão.

## O que este módulo resolve

O `@machize/admin` (o "motor") sabe **o que** mostrar — colunas, campos, validação — mas não desenha nada. Este pacote é a **camada React**: transforma esses modelos em elementos visíveis. Um **componente React** é uma função que devolve o que aparece no ecrã (escrito em JSX/TSX, uma sintaxe parecida com HTML dentro de TypeScript); as **props** são os parâmetros que passas ao componente para o configurar.

Na prática: defines um recurso uma vez (por exemplo "projetos", com o seu schema Zod) e este pacote dá-te de imediato uma tabela com cabeçalhos legíveis e células formatadas (booleanos como "Yes/No", datas como `2026-08-07`), e um formulário com o input certo para cada tipo de campo — caixa de texto para texto, *checkbox* para verdadeiro/falso, lista pendente (`<select>`) para enums, input numérico para números — já com validação e mensagens de erro por campo.

Importante: os componentes deste pacote produzem **HTML puro, sem estilos** (`<table>`, `<form>`, `<input>`…). É de propósito — aplicas o CSS que quiseres. Se preferes componentes já bonitos com Tailwind/shadcn, usa o pacote irmão `@machize/admin-shadcn`, que tem exatamente as mesmas props.

## Instalação

```bash
pnpm add @machize/admin-react @machize/admin zod
```

> Requisitos: `react` >= 18 (peer dependency — instala-lo tu no teu projeto). O `@machize/admin` vem como dependência direta, mas precisas do `zod` para escrever os schemas.

## Começar em 5 minutos

Vamos montar um mini-painel de projetos: uma lista e um formulário de criação.

**Passo 1 — Define o recurso** (lógica pura, sem React — podes pôr num ficheiro `resources.ts`):

```ts
// resources.ts
import { z } from 'zod'
import { defineResource, memoryDataSource } from '@machize/admin'

export const projects = defineResource({
  name: 'projects',
  schema: z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(['draft', 'published']),
    archived: z.boolean(),
  }),
  createSchema: z.object({
    name: z.string().min(3),
    status: z.enum(['draft', 'published']),
  }),
  columns: ['name', 'status', 'archived'],
})

// Fonte de dados em memória, só para experimentar:
export const source = memoryDataSource<{
  id: string
  name: string
  status: string
  archived: boolean
}>([{ id: 'p1', name: 'Apollo', status: 'draft', archived: false }])
```

**Passo 2 — Cria o ecrã** com os três exports principais:

```tsx
// ProjectsPage.tsx
import { DataTable, ResourceForm, useList } from '@machize/admin-react'
import { projects, source } from './resources'

export function ProjectsPage() {
  // useList carrega a lista quando o componente aparece no ecrã
  const { data, loading, error, reload } = useList(source)

  if (loading) return <p>A carregar…</p>
  if (error) return <p>Algo correu mal.</p>

  return (
    <div>
      <h1>{projects.label}</h1>

      <DataTable
        resource={projects}
        rows={data}
        onRowClick={(row) => console.log('clicaste em', row)}
      />

      <h2>Novo projeto</h2>
      <ResourceForm
        resource={projects}
        onSubmit={async (values) => {
          await source.create(values) // grava
          await reload()              // recarrega a tabela
        }}
      />
    </div>
  )
}
```

**Passo 3 — O que vês no ecrã:** uma tabela com cabeçalhos "Name", "Status", "Archived" (a coluna booleana mostra "Yes"/"No"), e por baixo um formulário com uma caixa de texto "Name", um `<select>` "Status" com as opções `draft`/`published` e um botão "Save". Se escreveres um nome com menos de 3 letras e carregares em "Save", aparece a mensagem de erro debaixo do campo e nada é gravado.

## Guia de utilização

### `DataTable` — tabela derivada do schema

Desenha as linhas de um recurso numa `<table>`. As colunas vêm de `resource.columns()` e cada célula é formatada por tipo com `formatCell`.

```tsx
import { DataTable } from '@machize/admin-react'
import { projects } from './resources'

<DataTable
  resource={projects}
  rows={[{ id: 'p1', name: 'Apollo', status: 'draft', archived: true }]}
  emptyLabel="Sem registos"                 // mostrado quando rows está vazio
  onRowClick={(row) => abrirDetalhe(row)}   // torna as linhas clicáveis
/>
```

No ecrã: cabeçalho `Name | Status | Archived`, uma linha `Apollo | draft | Yes`. Sem linhas, aparece uma única célula com `emptyLabel` a ocupar toda a largura.

### `ResourceForm` — formulário gerado e validado

Formulário **controlado** (o React guarda os valores enquanto escreves) gerado de `resource.formFields(mode)`. Ao submeter, valida com `resource.validate(values, mode)`; com erros, mostra uma mensagem por campo (elemento com `role="alert"`) e **não** chama `onSubmit`; sem erros, chama `onSubmit` com os dados já validados e convertidos pelo Zod.

Criar:

```tsx
import { ResourceForm } from '@machize/admin-react'
import { projects, source } from './resources'

<ResourceForm
  resource={projects}
  onSubmit={async (values) => { await source.create(values) }}
/>
```

Editar (modo `update`, com valores iniciais):

```tsx
<ResourceForm
  resource={projects}
  mode="update"
  initialValues={{ name: 'Apollo', status: 'draft' }}
  submitLabel="Guardar alterações"
  onSubmit={async (values) => { await source.update('p1', values) }}
/>
```

Inputs gerados por tipo de campo:

| Tipo do campo | Elemento no ecrã | Valor entregue |
|---|---|---|
| `string` | `<input type="text">` | `string` |
| `number` | `<input type="number">` | `number` (ou `undefined` se vazio) |
| `boolean` | `<input type="checkbox">` | `boolean` |
| `date` | `<input type="date">` | `string` (ex.: `'2026-08-07'`) |
| `enum` | `<select>` com as opções | `string` |
| `unknown` | `<input type="text">` | `string` |

### `useList` — carregar uma lista de dados

Um **hook** é uma função especial do React (começa por `use`) que dá superpoderes a um componente — aqui, carregar dados de um `AdminDataSource` quando o componente aparece, com estado de carregamento, erro e recarga manual.

```tsx
import { useList } from '@machize/admin-react'
import { source } from './resources'

function Lista() {
  const { data, loading, error, reload } = useList(source, { page: 1, pageSize: 20, search: 'apo' })
  // data: linhas carregadas; loading: true enquanto pede;
  // error: o erro lançado pela fonte (ou null); reload(): volta a pedir.
  return loading ? <p>…</p> : <button onClick={() => void reload()}>Recarregar ({data.length})</button>
}
```

Nota: os `params` são comparados por conteúdo (via `JSON.stringify`), por isso podes passar um objeto novo em cada render sem provocar pedidos em ciclo.

### `formatCell` — formatar um valor para apresentação

Usada internamente pelo `DataTable`; exportada para usares nas tuas próprias tabelas.

```ts
import { formatCell } from '@machize/admin-react'

formatCell(true, 'boolean')                    // 'Yes'
formatCell(false, 'boolean')                   // 'No'
formatCell(new Date('2026-08-07'), 'date')     // '2026-08-07'
formatCell(null, 'string')                     // ''
formatCell(42, 'number')                       // '42'
```

## Referência da API

### `DataTable` (componente)

| Prop | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `resource` | `Resource` | Sim | — | O recurso (de `defineResource`) que define as colunas. |
| `rows` | `Record<string, unknown>[]` | Sim | — | As linhas a mostrar. |
| `onRowClick` | `(row) => void` | Não | — | Chamado com a linha clicada. |
| `emptyLabel` | `string` | Não | `'No records'` | Texto quando não há linhas. |

A chave de cada linha é `row[resource.idField]` (ou o índice, se faltar).

### `ResourceForm` (componente)

| Prop | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `resource` | `Resource` | Sim | — | O recurso que define campos e validação. |
| `initialValues` | `Record<string, unknown>` | Não | `{}` | Valores pré-preenchidos. |
| `mode` | `'create' \| 'update'` | Não | `'create'` | Escolhe o schema de validação. |
| `onSubmit` | `(data) => void \| Promise<void>` | Sim | — | Recebe os dados validados/convertidos pelo Zod. |
| `submitLabel` | `string` | Não | `'Save'` | Texto do botão. |

Acessibilidade: o `<form>` tem `aria-label` `"<label do recurso> form"`; cada erro é um `<span role="alert" data-field="<nome>">`.

### `useList(source, params?)` (hook)

| Parâmetro | Tipo | Obrigatório? | Descrição |
|---|---|---|---|
| `source` | `AdminDataSource<T>` | Sim | Fonte de dados (de `@machize/admin`). |
| `params` | `ListParams` (`{ page?, pageSize?, search? }`) | Não | Parâmetros de listagem. |

Devolve `UseListResult<T>`:

| Campo | Tipo | Descrição |
|---|---|---|
| `data` | `T[]` | Linhas carregadas (`[]` inicialmente). |
| `loading` | `boolean` | `true` durante o pedido (começa a `true`). |
| `error` | `unknown` | Erro lançado por `source.list` (ou `null`). |
| `reload` | `() => Promise<void>` | Repete o pedido manualmente. |

### `formatCell(value, type): string` (função)

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `value` | `unknown` | O valor da célula. |
| `type` | `FieldType` | Tipo do campo (de `@machize/admin`). |

`null`/`undefined` → `''`; `boolean` → `'Yes'`/`'No'`; `date` → `AAAA-MM-DD` (ou `String(value)` se a data for inválida); restantes → `String(value)`.

### Tipos exportados

`DataTableProps`, `ResourceFormProps`, `UseListResult<T>` — as formas descritas nas tabelas acima.

## Erros comuns e soluções (FAQ)

**"A tabela/formulário aparece sem qualquer estilo."** É o comportamento esperado — este pacote emite HTML puro. Estiliza com o teu CSS (ex.: `table { … }`) ou usa `@machize/admin-shadcn` para ter componentes já estilizados.

**"O `onSubmit` nunca é chamado."** A validação falhou. Procura no ecrã as mensagens por baixo dos campos (elementos `role="alert"`). Confirma o `mode`: em `update` valida com `updateSchema` (ou `createSchema` em fallback).

**"O campo de data devolve texto, não `Date`."** O `<input type="date">` do browser produz uma string `'AAAA-MM-DD'`. Se o teu schema exigir `z.date()`, usa `z.coerce.date()` no schema de input para o Zod converter automaticamente.

**"O `useList` pede os dados em ciclo infinito."** Os `params` são estabilizados por conteúdo, mas o `source` é comparado por identidade. Cria a fonte de dados **fora** do componente (ou com `useMemo`) — se criares `memoryDataSource(...)` dentro do corpo do componente, cada render cria uma fonte nova e dispara novo pedido.

**"Alterei `initialValues` e o formulário não atualizou."** Os valores iniciais só são lidos na montagem (é um formulário controlado com estado interno). Para editar outro registo, remonta o componente com uma `key` diferente: `<ResourceForm key={row.id} … />`.

**"Erro sobre versões de React / hooks inválidos."** Garante uma única cópia de `react` >= 18 no projeto (é peer dependency).

## Como se liga aos outros módulos

- **`@machize/admin`** — o motor por baixo: `DataTable` usa `tableView`, `ResourceForm` usa `formView` + `resource.validate`, e `useList` consome qualquer `AdminDataSource`. Defines recursos lá; desenha-los aqui.
- **`@machize/admin-shadcn`** — alternativa visual com estilo shadcn/ui (Tailwind). O `DataTable` e o `ResourceForm` de lá têm as **mesmas props** — trocar de pacote é trocar o import.
- **`@machize/dashboard`** — organiza vários recursos em secções navegáveis; usa estes componentes para desenhar cada secção de recurso.
- **`@machize/sdk`** — implementa `AdminDataSource` sobre o cliente tipado do SDK para ligares estes componentes a um backend Machize real.
