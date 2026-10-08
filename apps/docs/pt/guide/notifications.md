# Notificações e mail

Avisa um utilizador de que algo aconteceu — "fatura paga", "novo comentário",
"subscrição a expirar" — uma vez, e entrega em todos os canais em que ele optou:
email, um sino in-app, SMS, WhatsApp. O
[`@basaltkit/notifications`](/reference/packages/notifications) valida o payload,
respeita as preferências por destinatário, e reporta o que foi enviado, saltado ou
falhado — um canal a falhar nunca bloqueia os outros. O
[`@basaltkit/mailer`](/reference/packages/mailer) é o motor de email por baixo
(e funciona sozinho): mails tipados, templating HTML seguro contra injeção, e
drivers substituíveis.

[[toc]]

## Modelo mental

Duas camadas, uma direção de dependência:

| Camada | Pacote | Função |
| --- | --- | --- |
| **Notifier** | `@basaltkit/notifications` | Um evento → muitos canais (`mail`, `inApp`, `sms`, `whatsapp`, custom), com preferências por destinatário e um relatório de entrega |
| **Mailer** | `@basaltkit/mailer` | Um mail tipado → um driver (SMTP, Resend, SES, Mailgun, log, memory), com templating HTML seguro e guardas contra header injection |

O canal `mail` faz a ponte entre as duas: quando o `mailerPlugin` está
registado, o notifier entrega mail através dele automaticamente. Usa o mailer
diretamente para fluxos transacionais que não são "notificações" (reset de
password, magic links).

## Definir uma notificação

Descreve-a uma vez: os dados (um schema Zod), os canais, e como cada canal a
apresenta.

```ts
import { defineNotification } from '@basaltkit/notifications'
import { z } from 'zod'

export const InvoicePaid = defineNotification({
  name: 'invoice.paid',
  schema: z.object({ amount: z.number(), number: z.string() }),
  channels: ['mail', 'inApp'],
  via: {
    mail: (d) => ({ subject: `Fatura ${d.number} paga`, text: `Recebemos ${d.amount}.` }),
    inApp: (d) => ({ title: 'Fatura paga', body: `${d.number} — ${d.amount}` }),
  },
})
```

`channels` também pode ser uma função `(recipient, data) => string[]` para
encaminhamento dinâmico. Cada renderer `via.<canal>` devolve a forma de mensagem
do canal — `{ subject, text?, html? }` para mail, `{ title, body?, data? }` para
in-app, `{ body }` para sms/whatsapp. Uma definição pode ainda definir `defaults`
e `mandatory` por canal — vê [Canais desligados por omissão e obrigatórios](#canais-desligados-por-omissao-e-obrigatorios).

## Registar e enviar

```ts
import { notificationsPlugin, NOTIFIER } from '@basaltkit/notifications'
import { mailerPlugin } from '@basaltkit/mailer'

app.use(mailerPlugin({ /* … */ })) // o canal mail liga-se sozinho quando há um mailer
app.use(notificationsPlugin())      // o canal inApp está ligado por omissão

const report = await container.get(NOTIFIER).notify(recipient, InvoicePaid, { amount: 90, number: 'A-1' })
// { sent: [{ channel: 'mail' }, { channel: 'inApp' }], failed: [], skipped: [] }
```

O destinatário vem primeiro, depois a definição, depois os dados. É qualquer
objeto `{ id, email?, phone?, channelPreferences? }`. Desliga um canal por
destinatário com `channelPreferences` (`{ sms: false }`) — canais desativados
aparecem em `skipped`. Um canal que lança erro fica em `failed` (com o erro) e
emite o hook `notification:failed`; entregas com sucesso emitem
`notification:sent`.

## O mailer

### Mails tipados

Um mail é definido uma vez — nome, schema e renderers — e depois enviado com
dados validados e um envelope:

```ts
import { defineMail, html, MAILER } from '@basaltkit/mailer'
import { z } from 'zod'

export const WelcomeEmail = defineMail({
  name: 'welcome',
  schema: z.object({ name: z.string() }),
  subject: ({ name }) => `Welcome, ${name}!`,
  text: ({ name }) => `Hello ${name}`,
  html: ({ name }) => html`<h1>Hello ${name}</h1>`,
})

await container.get(MAILER).send(WelcomeEmail, { name: 'Ada' }, { to: 'ada@acme.io' })
```

Dados inválidos lançam `MailValidationError` antes de qualquer envio. O envelope
é `{ to, from?, cc?, bcc?, replyTo? }`; um `to` em falta, ou um `from` em falta
(depois do default do plugin), lança `MailIncompleteError`.

### HTML seguro contra injeção — `` html`` ``, `raw()`, `escapeHtml()`

Os corpos de mail são normalmente renderizados a partir de dados **controlados
pelo utilizador** (nomes, títulos, comentários). Interpolá-los diretamente
entrega a um atacante markup dentro de mail enviado do teu próprio domínio
alinhado com DKIM/SPF — conteúdo de phishing, tracking pixels, XSS em clientes
webmail permissivos. O caminho seguro é o caminho por omissão: escreve os corpos
com o tagged template `` html`` `` e **todas as interpolações são escapadas
automaticamente** — lembrar-se de escapar não é preciso, esquecer não é possível.

```ts
import { html, raw, escapeHtml } from '@basaltkit/mailer'

html`<p>Hi ${userName}</p>`            // userName é escapado — sempre seguro
html`<div>${html`<b>${inner}</b>`}</div>` // templates aninhados compõem, sem duplo escape
html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>` // arrays renderizam item a item
raw('<hr>')                             // markup de confiança que tu escreveste — passa tal e qual
escapeHtml(value)                       // escape manual para strings construídas à mão
```

`html` devolve um `SafeHtml` que se converte no seu markup — cai direto no campo
`html` de um mail. Passa a `raw()` apenas **markup teu**, nunca input de
utilizadores.

### Ponto único contra header injection

Toda a mensagem resolvida passa pelo exportado `assertHeaderSafe(message)` antes
de chegar a **qualquer** driver (e outra vez depois de uma volta pela queue): um
CR/LF no subject ou um endereço malformado em `from`/`to`/`cc`/`bcc`/`replyTo` —
o vetor clássico `\r\nBcc: evil@x.com` — lança `MailHeaderInjectionError`
(`MAIL_HEADER_INJECTION`, status HTTP 400). Não o chamas tu; é o ponto único de
montagem, por isso todos os drivers ficam protegidos, não só o SMTP.

### Drivers

| Driver | `driver:` | Precisa de | Notas |
| --- | --- | --- | --- |
| Log | `'log'` (predefinição) | — | Imprime para um sink (default `console.log`). **Redige os corpos em produção** — vê abaixo |
| Memory | `'memory'` | — | Captura mensagens em processo — para testes |
| SMTP | `'smtp'` | `smtp: { … }` | Qualquer relay SMTP |
| Resend | `'resend'` | `resend: { … }` | API HTTP |
| SES | `'ses'` | `ses: { … }` | API do AWS SES |
| Mailgun | `'mailgun'` | `mailgun: { … }` | API HTTP |

Uma string `driver` não reconhecida **lança no arranque** — não cai
silenciosamente no driver de log, porque isso imprimiria todo o mail de saída
(links de reset incluídos) no stdout num deploy que só tinha um typo na config.

::: warning O driver de log redige os corpos em produção
Salvo com `NODE_ENV` explicitamente `development` ou `test` (portanto também
não definido ou `staging`), o `LogMailDriver` substitui o corpo por
`(body redacted in production — …)` — os corpos de mail transportam
rotineiramente links de reset de password, magic links e tokens, que não devem
ficar retidos num agregador de logs só porque um deploy ficou no driver por
omissão. Dev e teste ficam inalterados, por isso os teus magic links continuam a
imprimir localmente. Volta a optar explicitamente com `logBody: true`.
:::

### Layout, remetente por tenant, queue, preview

```ts
import { mailerPlugin, tenantFrom } from '@basaltkit/mailer'
import { smtpMailer } from '@basaltkit/mailer-smtp'

mailerPlugin({
  driver: smtpMailer({ url: process.env.SMTP_URL! }),
  from: tenantFrom('noreply@acme.io'),  // lê ctx().tenant.mailFrom, senão o fallback
  layout: (body, { mail }) => `<!doctype html><body>${body}</body>`, // wrapper de branding partilhado
})
```

- **`layout`** envolve todos os corpos HTML (branding/cabeçalho/rodapé); lê
  `ctx().tenant` lá dentro para branding por tenant. Qualquer motor de templates
  (MJML, React Email, Handlebars…) pode renderizar dentro do `layout` ou do
  próprio `html()` de um mail.
- **Queue** — `mailer.useQueue((m) => SendMail.dispatch(m))` entrega as
  mensagens resolvidas a um job do `@basaltkit/queue` cujo handler chama
  `mailer.deliver(m)`.
- **Preview** — declara `previews: [...]` e corre `basalt mail:preview` para um
  servidor de dev no browser que renderiza cada mail com dados de exemplo,
  através da validação de schema e do `layout` reais.

### Receber mail (inbound)

O mailer só **envia**. O Basalt não tem um pacote de mail de entrada: os
fornecedores (Postmark, SendGrid Inbound Parse, rotas do Mailgun, SES → SNS)
entregam as mensagens recebidas a um endpoint HTTP, muitas vezes como os bytes
`message/rfc822` em bruto. Recebe-as numa
[rota `rawBody()`](/pt/guide/adapters#corpos-de-pedido-em-bruto-assinaturas-de-webhook),
que entrega ao handler os bytes intactos em todos os adapters, e — quando o
fornecedor assina com um HMAC sobre o corpo — verifica esses bytes diretamente
com [`verifySignature(header, body.bytes, secret)`](/pt/guide/webhooks#verificar-bytes-raw)
antes de fazer o parse do MIME com a biblioteca que preferires. Nunca
descodifiques os bytes para string primeiro: uma mensagem que não seja UTF-8
válido deixaria de bater com a assinatura.

## SMS e WhatsApp

Entrega através de um `SmsSender` **agnóstico de fornecedor** — implementa um
método sobre Twilio, Vonage, MessageBird, AppyPay… e o framework não depende de
nenhum SDK de fornecedor.

```ts
import { SmsChannel, whatsappChannel, notificationsPlugin } from '@basaltkit/notifications'
import type { SmsSender } from '@basaltkit/notifications'

const twilio: SmsSender = {
  async send({ to, from, body }) {
    await twilioClient.messages.create({ to, from, body })
  },
}

app.use(notificationsPlugin({
  channels: [
    new SmsChannel(twilio, { from: '+15551234567' }),          // canal 'sms'
    whatsappChannel(twilio, { from: 'whatsapp:+15551234567' }), // canal 'whatsapp'
  ],
}))
```

O endereço vem de `recipient.phone` (o `whatsappChannel` prefere
`recipient.whatsapp ?? recipient.phone`). Aponta o `via.sms` / `via.whatsapp` da
notificação para uma mensagem `{ body }`:

```ts
const LowBalance = defineNotification({
  name: 'wallet.low',
  channels: ['sms', 'inApp'],
  via: {
    sms: (d) => ({ body: `Saldo ${d.amount}. Carrega para continuar a enviar.` }),
    inApp: (d) => ({ title: 'Saldo baixo' }),
  },
})
```

Ambos os canais respeitam o opt-out de `channelPreferences` como qualquer canal,
e um destinatário sem número de telefone aparece em `failed` sem bloquear os
outros.

## Preferências e digests

Para opt-out durável por notificação × canal, adiciona um `PreferenceStore`
(`notificationsPlugin({ preferences })`) — ganha a regra **mais específica**. Em
produção usa uma durável: `sqliteInAppStore(path).preferences` de
`@basaltkit/notifications-sqlite`, ou `prismaPreferenceStore(prisma)` de
`@basaltkit/notifications-prisma` (o modelo `NotificationPreference` está no
schema incluído). Para agrupar notificações de baixa prioridade num resumo
periódico, junta-as num `Digest` e faz `flush()` num agendamento. Vê a
[referência do pacote](/reference/packages/notifications) para a API completa.

### Canais desligados por omissão e obrigatórios

Uma definição pode mudar a predefinição por canal, e isentar canais do opt-out:

```ts
export const WeeklyDigest = defineNotification({
  name: 'digest.weekly',
  channels: ['mail', 'sms'],
  via: { /* … */ },
  defaults: { sms: false }, // opt-in: só quem ligou o SMS o recebe
})

export const PasswordChanged = defineNotification({
  name: 'security.password-changed',
  channels: ['mail', 'inApp'],
  via: { /* … */ },
  mandatory: ['mail'], // não pode ser silenciado
})
```

O notifier decide cada canal por esta ordem: um canal `mandatory` é sempre
enviado; um `channelPreferences: { x: false }` inline silencia-o; senão decide a
preferência guardada mais específica; depois um `true` inline; e só quando o
destinatário não disse nada se aplica `defaults[canal]` (por omissão `true`).
`NotificationPreferences.allowed()` não muda (permite por omissão); o novo
`preference()` devolve `undefined` quando nada corresponde.

## A caixa in-app

`inAppRoutes()` serve o sino do utilizador **autenticado** — o destinatário é
sempre a sessão, nunca um parâmetro:

| Rota | O quê |
| --- | --- |
| `GET /me/notifications` | Lista (`?unreadOnly`, `?limit` ≤ 100, por omissão 30) |
| `GET /me/notifications/unread-count` | `{ count }` |
| `POST /me/notifications/:id/read` | Marca uma como lida (404 para as de outra pessoa) |
| `POST /me/notifications/read-all` | Marca todas como lidas → `{ marked }` |

```ts
fastifyPlugin({ routes: [...inAppRoutes({ meta: { rateLimit: { max: 60 } } })] })
```

O `meta` é fundido em todas as rotas; `auth: true` é sempre aplicado por cima.
`read-all` marca **todas** as não lidas: numa só instrução numa store com
`markAllRead` (memória, SQLite, Prisma), ou página a página numa store própria
mais antiga — antes parava depois das primeiras 100.

### Agrupamento

Dá à mensagem in-app um `groupKey` para fundir repetições numa só linha enquanto
não for lida — "3 novos comentários no Contrato 12" em vez de três linhas:

```ts
via: {
  inApp: (d) => ({ title: `${d.author} comentou`, groupKey: `doc:${d.docId}:comments` }),
}
```

O `count` da linha não lida sobe e ela fica com o título, corpo e dados mais
recentes; depois de lida, a seguinte começa uma linha nova. Requer uma store com
`upsertGroup` (memória, SQLite, Prisma — o schema Prisma ganhou as colunas
opcionais `groupKey`/`count`); uma store própria sem ele acrescenta uma linha por
notificação.

### Retenção

As caixas crescem para sempre se nada as apagar. As stores com `prune` apagam
linhas lidas mais antigas que `readBefore` e não lidas mais antigas que
`unreadBefore` (epoch ms, de todos os destinatários). Corre-o no scheduler:

```ts
schedulerPlugin({
  define: (schedule) => {
    schedule.call('notifications:prune', async () => {
      const day = 86_400_000
      await app.container.get(IN_APP).prune?.({
        readBefore: Date.now() - 30 * day,
        unreadBefore: Date.now() - 180 * day,
      })
    }).daily().at('04:00')
  },
})
```

## Referência de opções

### `notificationsPlugin(options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `channels` | `NotificationChannel[]` | `[]` | Drivers de canal extra (sms, push, whatsapp, custom) para além dos embutidos `inApp`/`mail` |
| `inApp` | `InAppStore \| false` | store em memória | Persiste o sino in-app; `false` desativa o canal por completo |
| `preferences` | `PreferenceStore \| true` | desligado | Opt-outs duráveis por utilizador; `true` usa uma store em memória (dev) |
| `digest` | `DigestStore \| true` | desligado | Agrupa notificações de baixa prioridade para flush periódico |

### `mailerPlugin(options)`

| Opção | Tipo | Predefinição | Porquê |
| --- | --- | --- | --- |
| `driver` | `'smtp' \| 'log' \| 'memory' \| 'resend' \| 'ses' \| 'mailgun'` | `'log'` | Que transporte envia. Uma string desconhecida lança no arranque (sem fallback silencioso para log) |
| `smtp` / `resend` / `ses` / `mailgun` | opções do driver | — | Exigidas pelo driver correspondente |
| `from` | `string \| (() => string \| undefined)` | — | Remetente por omissão; uma função resolve a cada envio (`tenantFrom()` para branding por tenant) |
| `replyTo` | `string` | — | Reply-to por omissão |
| `layout` | `(html, { mail, data }) => string` | nenhum | Wrapper HTML partilhado aplicado a todos os corpos HTML |
| `sink` | `(line: string) => void` | `console.log` | Destino do output do driver de log |
| `logBody` | `boolean` | `true` com `NODE_ENV=development`/`test`, `false` em qualquer outro caso (incluindo não definido) | Só no driver de log: inclui o corpo na linha de log — os corpos transportam links de reset/tokens |
| `previews` | `MailPreview[]` | — | Mails expostos pelo servidor de dev `basalt mail:preview` |

## Modos de falha e resolução de problemas

| Erro / sintoma | Código | Quando |
| --- | --- | --- |
| `NotificationValidationError` | `NOTIFICATION_INVALID` | O payload falha o schema Zod da notificação — nada é enviado |
| `UnknownChannelError` | `NOTIFICATION_UNKNOWN_CHANNEL` | Uma definição aponta para um canal sem driver registado (ex.: `sms` sem um `SmsChannel`) |
| `MissingRendererError` | `NOTIFICATION_MISSING_RENDERER` | Uma definição aponta para um canal mas não define nenhum renderer `via.<canal>` |
| `RecipientEmailMissingError` | `NOTIFICATION_EMAIL_MISSING` | Canal mail: o destinatário não tem `email` — fica no `failed` do relatório, os outros canais entregam na mesma |
| `RecipientPhoneMissingError` | `NOTIFICATION_PHONE_MISSING` | SMS/WhatsApp: o destinatário não tem telefone — mesmo isolamento |
| `MailValidationError` | `MAIL_INVALID` | Os dados do mail falham o schema |
| `MailIncompleteError` | `MAIL_INCOMPLETE` | Sem destinatário no envelope, ou sem remetente em lado nenhum (envelope ou `from` do plugin) |
| `MailHeaderInjectionError` | `MAIL_HEADER_INJECTION` | CR/LF ou endereço malformado em subject/from/to/cc/bcc/replyTo — bloqueado antes de qualquer driver |
| `MailDeliveryError` | `MAIL_DELIVERY_FAILED` | Um driver de API (Resend, SES, Mailgun) recebeu uma resposta de erro do fornecedor |
| O arranque lança `Unknown mail driver "…"` | — | Typo na string `driver` — falha alto por desenho; válidos: `smtp, resend, ses, mailgun, memory, log` |
| Os corpos de mail mostram `(body redacted in production — …)` | — | Driver de log + `NODE_ENV` não explicitamente `development`/`test` (não definido conta como produção); passa `logBody: true` ou configura um driver real |

Combina com o [`@basaltkit/i18n`](/pt/guide/i18n) para renderizar conteúdo de
saída no locale do destinatário, e com o [`@basaltkit/queue`](/pt/guide/queues)
para entregar de forma assíncrona.
