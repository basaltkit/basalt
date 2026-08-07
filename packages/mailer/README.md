# @machize/mailer

Camada de email do framework Machize: define emails tipados uma vez e envia-os por SMTP, para a consola (desenvolvimento) ou para memória (testes). Precisas deste módulo sempre que a tua aplicação tiver de enviar emails — boas-vindas, faturas, recuperação de palavra-passe, etc.

## O que este módulo resolve

Enviar um email parece simples, mas na prática há vários problemas escondidos: garantir que os dados usados no texto do email estão corretos (não queres enviar "Olá undefined"), não repetir o endereço do remetente em todo o lado, conseguir testar sem enviar emails a sério, e não bloquear a aplicação enquanto o servidor de email responde.

Este módulo resolve isso com o conceito de **email tipado**: descreves cada email uma única vez com `defineMail` — o nome, os dados de que precisa (validados com um *schema*, ou seja, uma descrição formal do formato dos dados, normalmente feita com a biblioteca [Zod](https://zod.dev)), o assunto e o corpo. Depois, para enviar, chamas `mailer.send(...)` com os dados e o destinatário. Se os dados estiverem errados, o envio falha imediatamente com um erro claro, antes de qualquer email sair.

O envio real é feito por um **driver** (o componente que sabe falar com o mundo exterior). Há três incluídos: `smtp` (envio real através de um servidor de email, via nodemailer), `log` (escreve o email na consola — ideal em desenvolvimento) e `memory` (guarda os emails num array — ideal em testes). Podes trocar de driver sem mudar uma linha do resto do código.

## Instalação

```bash
pnpm add @machize/mailer
```

Se quiseres validar os dados dos emails (recomendado), instala também o Zod:

```bash
pnpm add zod
```

## Começar em 5 minutos

1. **Define um email** com `defineMail`. O `schema` descreve os dados; `subject`, `text` e `html` são funções que recebem esses dados e devolvem o texto:

```ts
// src/mails/welcome.ts
import { defineMail } from '@machize/mailer'
import { z } from 'zod'

export const WelcomeEmail = defineMail({
  name: 'welcome',
  schema: z.object({ name: z.string() }),
  subject: ({ name }) => `Bem-vindo, ${name}!`,
  text: ({ name }) => `Olá ${name}`,
  html: ({ name }) => `<h1>Olá ${name}</h1>`,
})
```

2. **Regista o plugin** na tua aplicação Machize. Em desenvolvimento usa o driver `log` (o predefinido), que só imprime na consola:

```ts
// src/app.ts
import { createApp } from '@machize/core'
import { mailerPlugin } from '@machize/mailer'

const app = await createApp({
  plugins: [
    mailerPlugin({ driver: 'log', from: 'noreply@aminhaapp.com' }),
  ],
}).boot()
```

3. **Envia o email.** Obtém o `Mailer` a partir do contentor da aplicação através do token `MAILER` (um *token* é a "chave" com que pedes um serviço registado ao contentor de dependências do Machize):

```ts
import { MAILER } from '@machize/mailer'
import { WelcomeEmail } from './mails/welcome.js'

const mailer = app.container.get(MAILER)
await mailer.send(WelcomeEmail, { name: 'Ada' }, { to: 'ada@example.com' })
```

4. Vais ver na consola algo como:

```
[mail] welcome → ada@example.com | Bem-vindo, Ada!
Olá Ada
```

5. **Em produção**, troca apenas a configuração do plugin para SMTP:

```ts
mailerPlugin({
  driver: 'smtp',
  smtp: { url: 'smtps://utilizador:password@smtp.exemplo.com:465' },
  from: 'noreply@aminhaapp.com',
})
```

## Guia de utilização

### Definir emails (templates)

Um "template de email" é aqui uma definição em código: nome + schema + funções de renderização. Emails sem dados também são possíveis (omite o `schema` e ignora o parâmetro):

```ts
import { defineMail } from '@machize/mailer'

const Ping = defineMail({ name: 'ping', subject: () => 'Ping', text: () => 'pong' })

// Envio de um email sem dados: só passas o envelope
await mailer.send(Ping, { to: 'a@b.c' })
```

### O envelope (destinatários e remetente)

O **envelope** é o conjunto de endereços do envio. Só o `to` é obrigatório; `from` pode vir do envelope ou da configuração do `Mailer`:

```ts
await mailer.send(WelcomeEmail, { name: 'Ada' }, {
  to: ['ada@example.com', 'grace@example.com'],
  cc: 'chefe@example.com',
  bcc: ['auditoria@example.com'],
  replyTo: 'suporte@aminhaapp.com',
  from: 'especial@aminhaapp.com', // opcional — sobrepõe o default
})
```

Se faltar `to` ou `from`, é lançado um `MailIncompleteError` (código `MAIL_INCOMPLETE`).

### Remetente por tenant (multi-inquilino)

Numa aplicação SaaS multi-tenant (vários clientes na mesma aplicação), cada cliente pode querer o seu próprio remetente. A opção `from` aceita uma função, avaliada em cada envio. O helper `tenantFrom` lê `ctx().tenant.mailFrom` do contexto do pedido:

```ts
import { mailerPlugin, tenantFrom } from '@machize/mailer'

mailerPlugin({ driver: 'smtp', smtp: { url: process.env.SMTP_URL! }, from: tenantFrom('fallback@aminhaapp.com') })
```

Dentro de um pedido cujo contexto tenha `tenant.mailFrom`, esse endereço é usado; fora disso, usa-se o fallback.

### Enviar em segundo plano (fila)

Por omissão, `send()` envia imediatamente (bloqueia até o driver terminar). Com `useQueue`, o `send()` passa a entregar a mensagem já renderizada a um despachante — tipicamente um job de `@machize/queue` — e o worker chama `deliver()`:

```ts
import { defineJob } from '@machize/queue'
import type { ResolvedMail } from '@machize/mailer'

const SendMail = defineJob({ name: 'mailer.send', handle: (m: ResolvedMail) => mailer.deliver(m) })
mailer.useQueue((m) => SendMail.dispatch(m))
```

### Testar sem enviar nada

O `MemoryMailDriver` guarda tudo o que "enviaste":

```ts
import { Mailer, MemoryMailDriver } from '@machize/mailer'

const driver = new MemoryMailDriver()
const mailer = new Mailer(driver, { from: 'noreply@test.dev' })

await mailer.send(WelcomeEmail, { name: 'Ada' }, { to: 'ada@example.com' })

console.log(driver.sent.length)            // 1
console.log(driver.ofMail('welcome')[0])   // a mensagem resolvida
```

## Referência da API

### `defineMail<T>(definition): MailDefinition<T>`

Cria uma definição de email tipada. Campos de `MailDefinition<T>`:

| Campo | Tipo | Obrigatório? | Descrição |
|---|---|---|---|
| `name` | `string` | Sim | Identificador único do email |
| `schema` | `MailSchema<T>` | Não | Schema com `safeParse` (compatível com Zod) para validar os dados |
| `subject` | `(data: T) => string` | Sim | Gera o assunto |
| `text` | `(data: T) => string` | Não | Gera o corpo em texto simples |
| `html` | `(data: T) => string` | Não | Gera o corpo em HTML |

### `class Mailer`

`new Mailer(driver: MailDriver, options?: MailerOptions)`

`MailerOptions`:

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `from` | `string \| (() => string \| undefined)` | Não | — | Remetente por omissão; a função é avaliada em cada envio |
| `replyTo` | `string` | Não | — | Endereço de resposta por omissão |

Métodos:

| Método | Assinatura | Descrição |
|---|---|---|
| `send` | `send(mail, data?, envelope) => Promise<void>` | Valida, renderiza e envia (ou coloca na fila). Com emails sem dados, o segundo argumento é logo o envelope |
| `deliver` | `deliver(message: ResolvedMail) => Promise<void>` | Envia uma mensagem já resolvida diretamente pelo driver (usado por workers de fila) |
| `resolve` | `resolve(mail, data, envelope) => ResolvedMail` | Renderiza sem enviar (testes/pré-visualização) |
| `useQueue` | `useQueue(dispatch) => this` | Redireciona `send()` para um despachante (fila) |

### `mailerPlugin(options?: MailerPluginOptions)`

Regista um `Mailer` singleton no contentor sob o token `MAILER`. `MailerPluginOptions` estende `MailerOptions` com:

| Opção | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `driver` | `'smtp' \| 'log' \| 'memory'` | Não | `'log'` | Driver de envio |
| `smtp` | `SmtpDriverOptions` | Sim, se `driver: 'smtp'` | — | `{ url: 'smtp(s)://user:pass@host:porta' }` |
| `sink` | `(line: string) => void` | Não | `console.log` | Destino das linhas do driver `log` |

### Drivers

Todos implementam `MailDriver` (`name`, `send(message)`, `disconnect()`):

| Driver | Uso | Notas |
|---|---|---|
| `SmtpMailDriver` | Produção | `new SmtpMailDriver({ url })`, envia via nodemailer |
| `LogMailDriver` | Desenvolvimento | `new LogMailDriver(sink?)`, imprime a mensagem |
| `MemoryMailDriver` | Testes | Propriedade `sent: ResolvedMail[]` e método `ofMail(name)` |

### Outros exports

| Export | Tipo | Descrição |
|---|---|---|
| `MAILER` | token | Chave do `Mailer` no contentor |
| `tenantFrom(fallback?)` | função | Remetente dinâmico que lê `ctx().tenant.mailFrom` |
| `Envelope` | tipo | `{ to, from?, cc?, bcc?, replyTo? }` |
| `ResolvedMail` | tipo | Mensagem final: `{ mail, to[], from, cc[], bcc[], replyTo?, subject, text?, html? }` |
| `MailValidationError` | erro | Código `MAIL_INVALID` — dados não passam no schema |
| `MailIncompleteError` | erro | Código `MAIL_INCOMPLETE` — falta `to` ou `from` |
| `MailSchema<T>` | tipo (Avançado) | Contrato estrutural de schema (`safeParse`) |
| `MailDriver` | tipo (Avançado) | Contrato para escrever o teu próprio driver |

## Erros comuns e soluções (FAQ)

**"Mail has no sender" (`MAIL_INCOMPLETE`)** — Não configuraste `from` no `mailerPlugin`/`Mailer` nem o passaste no envelope. Define um remetente por omissão.

**"Mail has no recipient" (`MAIL_INCOMPLETE`)** — O `to` do envelope está vazio (`[]`) ou em falta. Passa pelo menos um endereço.

**`MailValidationError` (`MAIL_INVALID`)** — Os dados passados ao `send()` não correspondem ao `schema` do email (ex.: número onde era esperado texto). O erro inclui os `issues` do Zod a indicar o campo errado.

**Os emails não chegam em desenvolvimento** — Provavelmente estás com o driver `log` (o predefinido), que só imprime na consola. É intencional; usa `driver: 'smtp'` para envio real.

**Configurei `useQueue` e nada é enviado** — Com fila ativa, `send()` só entrega ao despachante; é o worker que tem de chamar `mailer.deliver(mensagem)`.

## Como se liga aos outros módulos

- **@machize/core** — fornece `createApp`, o contentor de dependências onde o `MAILER` fica registado e o contexto (`ctx`) usado por `tenantFrom`.
- **@machize/notifications** — quando o mailer está registado, o plugin de notificações cria automaticamente o canal `mail`, que envia emails através deste módulo (herdando fila e remetente por tenant).
- **@machize/queue** — combina com `useQueue` para enviar emails em segundo plano com retries.
- **@machize/subscriptions** — os hooks de faturação (ex.: `billing:trial_expired`) são um ponto natural para disparar emails definidos aqui.
