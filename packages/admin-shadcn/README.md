# @machize/admin-shadcn

Componentes React com o estilo **shadcn/ui** para o motor `@machize/admin`: primitivas visuais (Button, Input, Table, Card, Badge…) e versões já estilizadas do `DataTable` e do `ResourceForm`. Precisas dele quando queres um painel de administração bonito "out of the box", com Tailwind CSS — é o pacote que o scaffold `create-machize --ui` usa.

## O que este módulo resolve

O `@machize/admin-react` gera tabelas e formulários corretos mas em HTML puro, sem estilo. Este pacote dá o passo seguinte: os mesmos componentes, com o aspeto do **shadcn/ui** — um conjunto de componentes muito popular no ecossistema React, construído sobre **Tailwind CSS** (uma forma de estilizar escrevendo classes utilitárias como `rounded-md` ou `text-sm` diretamente nos elementos).

Além do `DataTable` e do `ResourceForm` estilizados, o pacote exporta as próprias primitivas shadcn — `Button`, `Input`, `Label`, `Table`, `Card`, `Badge` — para construíres o resto do teu painel (cabeçalhos, cartões de métricas, botões de ação) com o mesmo visual, sem teres de copiar os ficheiros do shadcn para o teu projeto.

Uma nota importante: as classes Tailwind só produzem cores e espaçamentos se a tua aplicação tiver o **Tailwind CSS configurado** com as variáveis de tema do shadcn (cores como `--primary`, `--border`, etc.). O scaffold `create-machize --ui` trata disso por ti; se estiveres a integrar à mão, vê a secção de instalação.

## Instalação

```bash
pnpm add @machize/admin-shadcn @machize/admin zod
```

Requisitos:

1. **`react` >= 18** (peer dependency — instalada por ti).
2. **Tailwind CSS** configurado no teu projeto, com o tema shadcn (as variáveis CSS `--background`, `--primary`, `--destructive`, etc. — vê [ui.shadcn.com/docs/installation](https://ui.shadcn.com/docs/installation)).
3. No `tailwind.config`, inclui os ficheiros deste pacote no `content`, para o Tailwind gerar as classes usadas cá dentro:

```js
// tailwind.config.js
export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
    './node_modules/@machize/admin-shadcn/dist/**/*.js', // ← importante
  ],
  // ... resto da configuração shadcn (cores, radius, etc.)
}
```

> Atalho: `pnpm create machize minha-app --ui` gera um projeto completo (API + frontend Vite/React) com tudo isto já configurado.

## Começar em 5 minutos

**Passo 1 — Define o recurso** (igual ao `@machize/admin` — a lógica é partilhada):

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

export const source = memoryDataSource<{
  id: string
  name: string
  status: string
  archived: boolean
}>([{ id: 'p1', name: 'Apollo', status: 'draft', archived: false }])
```

**Passo 2 — Monta a página** com os componentes estilizados:

```tsx
// ProjectsPage.tsx
import { useState } from 'react'
import { useList } from '@machize/admin-react' // hook de dados (opcional mas prático)
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  ResourceForm,
} from '@machize/admin-shadcn'
import { projects, source } from './resources'

export function ProjectsPage() {
  const { data, loading, reload } = useList(source)
  const [aCriar, setACriar] = useState(false)

  if (loading) return <p>A carregar…</p>

  return (
    <Card>
      <CardHeader>
        <CardTitle>{projects.label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={() => setACriar((v) => !v)}>Novo projeto</Button>

        {aCriar ? (
          <ResourceForm
            resource={projects}
            onSubmit={async (values) => {
              await source.create(values)
              setACriar(false)
              await reload()
            }}
          />
        ) : null}

        <DataTable resource={projects} rows={data} emptyLabel="Sem projetos" />
      </CardContent>
    </Card>
  )
}
```

**Passo 3 — O que vês no ecrã:** um cartão com cantos arredondados e sombra, o título "Projects", um botão primário "Novo projeto", e a tabela shadcn — cabeçalhos discretos, linhas com *hover*, e a coluna booleana "Archived" mostrada como uma **badge** (etiqueta colorida): "Yes" com fundo primário, "No" com fundo secundário. O formulário aparece com inputs arredondados, labels alinhadas e mensagens de erro a vermelho (`text-destructive`).

## Guia de utilização

### `DataTable` — tabela shadcn derivada do schema

Mesmas props do `DataTable` de `@machize/admin-react`; muda a apresentação: usa as primitivas `Table*`, células booleanas viram `Badge` ("Yes" = variante `default`, "No" = `secondary`), datas formatadas `AAAA-MM-DD`, e com `onRowClick` as linhas ganham `cursor-pointer`.

```tsx
import { DataTable } from '@machize/admin-shadcn'
import { projects } from './resources'

<DataTable
  resource={projects}
  rows={[{ id: 'p1', name: 'Apollo', status: 'draft', archived: true }]}
  onRowClick={(row) => console.log(row)}
  emptyLabel="Sem registos"
/>
```

### `ResourceForm` — formulário shadcn gerado e validado

Mesmo comportamento do `ResourceForm` de `@machize/admin-react` (formulário controlado, valida ao submeter, mostra erros por campo, só chama `onSubmit` com dados válidos), com visual shadcn: `Label` + `Input` estilizados, `<select>` com o mesmo estilo dos inputs, erros em `text-destructive`, botão `Button` primário.

```tsx
import { ResourceForm } from '@machize/admin-shadcn'
import { projects, source } from './resources'

<ResourceForm
  resource={projects}
  mode="update"
  initialValues={{ name: 'Apollo', status: 'draft' }}
  submitLabel="Guardar"
  onSubmit={async (values) => { await source.update('p1', values) }}
/>
```

Inputs por tipo de campo: `string`/`unknown` → `Input` de texto; `number` → `Input` numérico; `date` → `Input` de data; `boolean` → checkbox; `enum` → `<select>` estilizado com as opções.

### Primitivas shadcn

Todas aceitam as props HTML normais do elemento correspondente (incluindo `className` para acrescentares classes Tailwind, fundidas com `cn`).

**`Button`** — botão com variantes visuais:

```tsx
import { Button } from '@machize/admin-shadcn'

<Button>Guardar</Button>
<Button variant="destructive" size="sm">Apagar</Button>
<Button variant="outline">Cancelar</Button>
<Button asChild variant="link">
  <a href="/docs">Documentação</a>  {/* asChild: aplica o estilo ao filho */}
</Button>
```

**`Input` e `Label`** — campo de texto e etiqueta:

```tsx
import { Input, Label } from '@machize/admin-shadcn'

<div className="space-y-2">
  <Label htmlFor="email">Email</Label>
  <Input id="email" type="email" placeholder="tu@exemplo.com" />
</div>
```

**`Table` e família** — tabela composta à mão (quando o `DataTable` automático não chega):

```tsx
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@machize/admin-shadcn'

<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Nome</TableHead>
      <TableHead>Estado</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow>
      <TableCell>Apollo</TableCell>
      <TableCell>draft</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

**`Card` e família** — cartão com cabeçalho e conteúdo:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@machize/admin-shadcn'

<Card>
  <CardHeader>
    <CardTitle>MRR</CardTitle>
  </CardHeader>
  <CardContent>1 250 €</CardContent>
</Card>
```

**`Badge`** — etiqueta pequena de estado:

```tsx
import { Badge } from '@machize/admin-shadcn'

<Badge>Ativo</Badge>
<Badge variant="secondary">Rascunho</Badge>
<Badge variant="destructive">Em atraso</Badge>
<Badge variant="outline">Beta</Badge>
```

**`cn`** — utilitário para juntar classes Tailwind sem conflitos (o último ganha):

```ts
import { cn } from '@machize/admin-shadcn'

cn('px-2', 'px-4')                        // 'px-4'
cn('text-sm', condicao && 'font-bold')    // junta condicionalmente
```

## Referência da API

### `DataTable` (componente)

| Prop | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `resource` | `Resource` | Sim | — | Recurso de `defineResource` (define as colunas). |
| `rows` | `Record<string, unknown>[]` | Sim | — | Linhas a mostrar. |
| `onRowClick` | `(row) => void` | Não | — | Torna as linhas clicáveis (`cursor-pointer`). |
| `emptyLabel` | `string` | Não | `'No records'` | Texto centrado quando não há linhas. |

### `ResourceForm` (componente)

| Prop | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `resource` | `Resource` | Sim | — | Recurso (campos + validação). |
| `initialValues` | `Record<string, unknown>` | Não | `{}` | Valores pré-preenchidos. |
| `mode` | `'create' \| 'update'` | Não | `'create'` | Escolhe o schema de validação. |
| `onSubmit` | `(data) => void \| Promise<void>` | Sim | — | Recebe dados validados pelo Zod. |
| `submitLabel` | `string` | Não | `'Save'` | Texto do botão. |

### `Button` (componente)

Estende `ButtonHTMLAttributes<HTMLButtonElement>` mais:

| Prop | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `variant` | `'default' \| 'destructive' \| 'outline' \| 'secondary' \| 'ghost' \| 'link'` | Não | `'default'` | Estilo visual. |
| `size` | `'default' \| 'sm' \| 'lg' \| 'icon'` | Não | `'default'` | Tamanho. |
| `asChild` | `boolean` | Não | `false` | Aplica o estilo ao elemento filho (via Radix Slot) em vez de renderizar um `<button>`. |

`buttonVariants({ variant?, size? })` (Avançado) — devolve a string de classes, para estilizares outros elementos como botões.

### `Badge` (componente)

Estende `HTMLAttributes<HTMLDivElement>` mais:

| Prop | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `variant` | `'default' \| 'secondary' \| 'destructive' \| 'outline'` | Não | `'default'` | Estilo visual. |

`badgeVariants({ variant? })` (Avançado) — devolve a string de classes.

### Primitivas restantes

| Export | Renderiza | Props |
|---|---|---|
| `Input` | `<input>` estilizado | `InputProps` = `InputHTMLAttributes<HTMLInputElement>` |
| `Label` | `<label>` estilizado | `LabelProps` = `LabelHTMLAttributes<HTMLLabelElement>` |
| `Table` | `<table>` num contentor com scroll horizontal | atributos HTML de `<table>` |
| `TableHeader` / `TableBody` | `<thead>` / `<tbody>` | atributos HTML da secção |
| `TableRow` | `<tr>` com hover | atributos HTML de `<tr>` |
| `TableHead` / `TableCell` | `<th>` / `<td>` | atributos HTML da célula |
| `Card` / `CardHeader` / `CardTitle` / `CardContent` | `<div>`s estilizados | `HTMLAttributes<HTMLDivElement>` |

Todos aceitam `className` e reencaminham `ref` (exceto `Badge`, que é uma função simples).

### `cn(...inputs): string` (função)

Junta classes condicionais (`clsx`) e resolve conflitos Tailwind (`tailwind-merge`). Aceita strings, arrays, objetos `{ classe: condicao }`, `false`/`undefined` (ignorados).

### Tipos exportados

`DataTableProps`, `ResourceFormProps`, `ButtonProps`, `InputProps`, `LabelProps`, `BadgeProps`.

## Erros comuns e soluções (FAQ)

**"Os componentes aparecem sem cores/estilo."** Duas causas habituais: (1) o Tailwind não está a analisar os ficheiros deste pacote — acrescenta `'./node_modules/@machize/admin-shadcn/dist/**/*.js'` ao `content` do `tailwind.config`; (2) faltam as variáveis de tema shadcn (`--primary`, `--border`, …) no teu CSS global — segue o guia de instalação do shadcn/ui ou usa o scaffold `create-machize --ui`.

**"O botão fica com fundo transparente/estranho."** As cores vêm das variáveis CSS do tema shadcn. Sem `--primary` e companhia definidas em `:root`, as classes `bg-primary` etc. não têm valor.

**"`asChild` dá erro `React.Children.only`."** Com `asChild`, o `Button` exige exatamente **um** elemento filho (ex.: um único `<a>`). Vem do Radix Slot.

**"O `onSubmit` do `ResourceForm` não dispara."** A validação falhou — procura o texto vermelho por baixo do campo (`role="alert"`). O comportamento é idêntico ao de `@machize/admin-react`.

**"Alterei `initialValues` e o formulário não mudou."** Os valores iniciais só são lidos na montagem. Remonta com `key` diferente: `<ResourceForm key={registo.id} … />`.

**"Quero um hook para carregar dados — não vejo `useList` aqui."** O `useList` vive em `@machize/admin-react` (este pacote só traz componentes visuais). Podes usar os dois pacotes em conjunto sem problema.

## Como se liga aos outros módulos

- **`@machize/admin`** — o motor headless: este pacote desenha os view models `tableView`/`formView` e valida com `resource.validate`. Os recursos definem-se lá.
- **`@machize/admin-react`** — a versão sem estilos dos mesmos `DataTable`/`ResourceForm` (props idênticas), mais o hook `useList` e o `formatCell`. Trocar entre os dois pacotes é trocar o import.
- **`@machize/dashboard`** — define as secções e métricas de um painel; usa estas primitivas (`Card`, `Badge`, `DataTable`) para as apresentar.
- **`@machize/sdk`** — o cliente HTTP tipado; no frontend gerado pelo scaffold, os dados chegam via SDK e são mostrados com estes componentes.
- **`create-machize --ui`** — o scaffold do Machize gera um frontend Vite + React já configurado com Tailwind, o tema shadcn e este pacote a falar com a API através do `@machize/sdk` (projetos `--ui` usam workspaces pnpm).
