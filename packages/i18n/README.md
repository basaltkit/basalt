# @machize/i18n

Internacionalização para o Machize: **locale resolvido do contexto** (por utilizador/tenant), **catálogos de mensagens tipados** com interpolação e plurais, e **formatação** (números, moeda, datas, tempo relativo, listas) via `Intl` nativo. **Zero dependências**. Precisas deste módulo quando a tua aplicação serve utilizadores em várias línguas/regiões.

## O que este módulo resolve

Num pedido, quem responde precisa de saber em que língua falar — e isso normalmente é o locale do utilizador (ou do tenant). Este módulo resolve o locale automaticamente do contexto do pedido, traduz mensagens tipadas (com `{parâmetros}` e plurais corretos por língua), e formata números/datas/moeda com as regras da região — tudo com o `Intl` que já vem no runtime.

## Instalação

```bash
pnpm add @machize/i18n
```

Depende apenas do `@machize/core`. Sem catálogos externos nem serviços — as mensagens vivem em código.

## Começar em 5 minutos

```ts
import { createApp } from '@machize/core'
import { i18nPlugin, I18N, defineMessages } from '@machize/i18n'

const en = defineMessages({
  greeting: 'Hi {name}',
  notes: { one: '{count} note', other: '{count} notes' },
})
const pt = defineMessages({
  greeting: 'Olá {name}',
  notes: { one: '{count} nota', other: '{count} notas' },
})

const app = await createApp({
  plugins: [i18nPlugin({ locales: { en, pt }, defaultLocale: 'en' })],
}).boot()

const i18n = app.container.get(I18N)

// locale explícito
i18n.in('pt').t('greeting', { name: 'Ada' }) // 'Olá Ada'
i18n.in('en').t('notes', { count: 3 })        // '3 notes'
```

Dentro de um pedido, `i18n.t(...)` usa o locale do **contexto** — sem passares nada:

```ts
i18n.t('greeting', { name: user.name }) // usa ctx().user.locale (ou tenant.locale)
```

## Locale do contexto

Por omissão, o locale vem de `ctx().user.locale` e, em alternativa, `ctx().tenant.locale` — bastando que guardes um campo `locale` nesses registos. Fornece uma resolução própria se preferires:

```ts
i18nPlugin({ locales, defaultLocale: 'en', resolveLocale: () => ctx().user?.preferredLocale })
```

Um pedido de `pt-BR` sem catálogo `pt-BR` **negoceia** para `pt` (a língua base); se também não existir, cai no `defaultLocale`. A formatação usa o locale pedido (ex.: datas em `pt-BR`).

## Plurais

Uma mensagem pode ser um objeto de formas plurais (categorias CLDR: `one`, `other`, `few`, `many`…), escolhidas por `Intl.PluralRules` a partir de `count`:

```ts
const en = defineMessages({ items: { one: '{count} item', other: '{count} items' } })
i18n.in('en').t('items', { count: 1 }) // '1 item'
i18n.in('en').t('items', { count: 5 }) // '5 items'
```

## Formatação (Intl)

Cada `t` vem acompanhado de formatadores no mesmo locale:

```ts
const l = i18n.in('en')
l.n(1234.5)                    // '1,234.5'
l.currency(9.9, 'USD')         // '$9.90'
l.date(new Date(), { dateStyle: 'long' })
l.relativeTime(-1, 'day')      // '1 day ago'
l.list(['a', 'b', 'c'])        // 'a, b, and c'
```

## Referência da API

### `defineMessages(catalog)`

Fixa os tipos de um catálogo (`{ chave: string | formasPlurais }`) para autocompletar em `t`.

### `i18nPlugin({ locales, defaultLocale, resolveLocale? })`

Regista o token `I18N`. `locales` é `{ [locale]: catálogo }`.

### `class I18n` / `Translator`

| Membro | Descrição |
|---|---|
| `locale()` | O locale resolvido para o pedido atual. |
| `in(locale)` | Um `Translator` fixado a um locale. |
| `t(key, params?)` | Traduz no locale atual. |
| `n` · `currency` · `date` · `relativeTime` · `list` | Formatação via `Intl` no locale atual. |

> Nota: pelo token `I18N`, o tipo genérico do catálogo é apagado. Importa a instância criada com `defineMessages` diretamente do teu módulo para manter os nomes/tipos das chaves.

## Como se liga aos outros módulos

- **`@machize/core`** — fornece o contexto de pedido de onde vem o locale.
- **`@machize/auth` / `@machize/tenancy`** — colocam `user`/`tenant` no contexto; guarda um `locale` neles para resolução automática.
- **`@machize/mailer` / `@machize/notifications`** — traduz o conteúdo de emails/notificações no locale do destinatário.
