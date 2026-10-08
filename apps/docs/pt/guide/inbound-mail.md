# Mail de entrada

O `@basaltkit/inbound-mail` recebe email numa app Basalt. Um relay envia cada
mensagem à app como **bytes em bruto assinados**, um destinatário por pedido. A
rota verifica a assinatura, encaminha a mensagem pelo endereço do destinatário
assinado e dá ao teu handler um parser com limites que só acredita nos
veredictos de autenticação escritos por servidores em que confias.

```bash
pnpm add @basaltkit/inbound-mail
```

O pacote é opt-in e sem estado: sem plugin, sem token, sem storage, sem
migrações. O `inboundMailRoutes()` devolve rotas normais, como o
[`driveRoutes()`](/pt/guide/drives#rotas), e elas correm sem alterações em
Fastify, Express e Hono. O desenho está registado no RFC 0003
(`docs/rfcs/0003-basaltkit-inbound-mail.md`).

[[toc]]

## Porquê bytes e não strings

Uma app que recebe mail à mão costuma errar em duas coisas, e nenhuma delas dá
um erro visível.

1. **Assina ou verifica uma string em vez dos bytes.** O MIME não é UTF-8. Uma
   mensagem Latin-1 de 8 bits descodificada para string e codificada outra vez
   é uma mensagem diferente, por isso uma assinatura sobre ela ou falha no mail
   real ou acaba desligada. O relay assina os octetos exatos, a rota lê-os com
   [`rawBody()`](/pt/guide/adapters#corpos-de-pedido-em-bruto-assinaturas-de-webhook),
   e nada pelo meio os descodifica.
2. **Confia num cabeçalho `Authentication-Results` escrito pelo remetente.**
   Qualquer pessoa pode pôr `dmarc=pass` num cabeçalho. O `parseInbound()` só lê
   veredictos escritos pelos servidores que indicares. Vê
   [Authentication-Results e ARC](#authentication-results-e-arc).

## Início rápido

### 1. O relay: Cloudflare Email Routing

Encaminha `*@in.example.com` (um catch-all) para um Worker. O Worker lê a
mensagem em bruto, assina-a com o formato de transmissão v1 e envia-a para a tua
app. Guarda os dois secrets com `wrangler secret put`. O secret tem de ter pelo
menos 16 caracteres (usa `generateWebhookSecret()` do `@basaltkit/webhooks`).

```js
// Cloudflare Email Routing -> Basalt relay (wire format v1, RFC 0003).
// Secrets: BASALT_INBOUND_URL and BASALT_INBOUND_SECRET (wrangler secret put).
const MAX_BYTES = 10 * 1024 * 1024 // keep in step with signedDriver({ maxRequestBytes })
const encoder = new TextEncoder()

export async function signDelivery(raw, from, to, oversize, secret, t) {
  // HMAC-SHA256 over `${t}.` ++ canonical, canonical = framing ++ raw bytes.
  const prefix = encoder.encode(`${t}.`)
  const head = encoder.encode(`basalt-inbound-v1\n${from}\n${to}\n${oversize ?? ''}\n`)
  const signed = new Uint8Array(prefix.length + head.length + raw.length)
  signed.set(prefix)
  signed.set(head, prefix.length)
  signed.set(raw, prefix.length + head.length)
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed))
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  const headers = {
    'content-type': 'message/rfc822',
    'x-basalt-signature': `t=${t},v1=${hex}`,
    'x-basalt-mail-from': from,
    'x-basalt-mail-to': to,
  }
  if (oversize !== undefined) headers['x-basalt-mail-oversize'] = String(oversize)
  return headers
}

export default {
  async email(message, env) {
    // Over the ceiling, only a signed notice with the size is sent.
    const oversize = message.rawSize > MAX_BYTES ? message.rawSize : undefined
    const raw = oversize === undefined ? new Uint8Array(await new Response(message.raw).arrayBuffer()) : new Uint8Array(0)
    const t = Math.floor(Date.now() / 1000)
    const headers = await signDelivery(raw, message.from, message.to, oversize, env.BASALT_INBOUND_SECRET, t)
    const res = await fetch(env.BASALT_INBOUND_URL, { method: 'POST', body: raw, headers })
    // Throwing makes Email Routing answer the sending server with a temporary
    // failure, so it retries later: right for a 5xx, and for a 401, which
    // means the two secrets disagree (an operator error a retry can outlive).
    if (res.status >= 500 || res.status === 401) throw new Error(`inbound mail endpoint answered ${res.status}`)
    // Any other 4xx is permanent (malformed, over a limit): bounce it.
    if (res.status >= 400) message.setReject(`rejected (${res.status})`)
  },
}
```

A suite de testes do pacote corre exatamente este Worker contra o
`signedDriver`, por isso o snippet e o driver não podem divergir. Qualquer outro
relay (um poller IMAP, uma Lambda, o teu próprio MTA) pode assinar da mesma
forma. Em Node, chama `signInboundMail(raw, { from, to }, secret)` e envia os
cabeçalhos que devolve.

### 2. A rota

```ts
import { createApp } from '@basaltkit/core'
import { fastifyPlugin } from '@basaltkit/fastify'
import { inboundMailRoutes, signedDriver } from '@basaltkit/inbound-mail'

const mailRoutes = inboundMailRoutes({
  driver: signedDriver({ secret: [process.env.INBOUND_SECRET!] }),
  parse: {
    trustedAuthservIds: ['mx.cloudflare.net'],
    trustedArcSealers: ['google.com', 'outlook.com'],
  },
  meta: { rateLimit: { limit: 60, windowMs: 60_000 } },
  routes: [
    {
      address: '{tenant}@in.example.com',
      async handler({ mail, match, parse }) {
        const tenant = await tenancy.find(match.params.tenant!)
        if (!tenant) return // empresa desconhecida: aceitar e descartar
        await tenancy.run(tenant, async () => {
          const parsed = await parse()
          // … guardar mail.raw, arquivar os anexos, registar parsed.auth.dmarc
        })
      },
    },
  ],
})

await createApp({ plugins: [fastifyPlugin({ routes: [...appRoutes, ...mailRoutes] })] }).boot()
```

A rota é `POST /inbound/mail` por omissão (muda-a com `url`). É declarada com
`meta: { auth: false }`, porque a assinatura é a autenticação. O teu `meta` é
fundido por cima desse default.

## Formato de transmissão v1

Um `POST` leva uma entrega para um destinatário.

| Cabeçalho | Conteúdo |
| --- | --- |
| `content-type` | `message/rfc822` ou `application/octet-stream` (parâmetros como `; charset=` são ignorados) |
| `x-basalt-signature` | `t=<segundos unix>,v1=<hex>`, com um `v1=` por secret durante uma rotação |
| `x-basalt-mail-from` | o `MAIL FROM` SMTP como o relay o viu. Pode vir vazio (um bounce). |
| `x-basalt-mail-to` | o único `RCPT TO` SMTP desta entrega |
| `x-basalt-mail-oversize` | opcional: o tamanho original, quando o relay não reencaminhou os bytes |

A assinatura é a [assinatura de webhook](/pt/guide/webhooks#verificar-bytes-raw),
calculada sobre uma mensagem canónica que inclui o envelope:

```
canonical = utf8("basalt-inbound-v1\n" + from + "\n" + to + "\n" + (oversize ?? "") + "\n") ++ raw
header    = signPayload(canonical, secrets, t)
```

O envelope está dentro da assinatura. Caso contrário, uma entrega capturada
podia ser repetida para outro tenant editando um cabeçalho não assinado. Os
endereços têm de ser únicos, em ASCII imprimível e ter no máximo 320
caracteres. O formato está congelado por um vetor de referência no RFC 0003 e
nos testes. Os nomes dos cabeçalhos podem ser mudados com
`signedDriver({ headers })` e `signInboundMail(…, { headers })`.

Para rodar o secret, configura primeiro `secret: [novo, atual]` no servidor,
depois muda o relay para `novo` e, por fim, retira `atual`.

## Encaminhamento e tenancy

O `address` é um destes:

- um endereço exato: `'invoices@in.example.com'`;
- marcadores `{param}` na parte local ou no domínio:
  `'{tenant}@in.example.com'`, `'invoices@{tenant}.in.example.com'`;
- um predicado: `(address) => ({ kind: 'support' })` ou `false`.

A comparação ignora maiúsculas. Um subendereço `+tag` é separado antes da
comparação, por isso `acme+marco@in.example.com` corresponde a
`'{tenant}@in.example.com'` com `match.tag === 'marco'` (a tag é texto escolhido
pelo remetente). Um `{param}` só captura `[a-z0-9_-]{1,63}`. Qualquer outra coisa
(`a.b`, `%`, partes locais entre aspas) não corresponde. As rotas são testadas
por ordem e a primeira que corresponde ganha.

**Nenhuma rota corresponder não é um erro.** O `onUnrouted(address, mail)`
corre, o hook `inbound-mail:unrouted` dispara e a resposta é o mesmo
`200 { "accepted": true }` que uma entrega encaminhada recebe. O endpoint não
serve, portanto, para descobrir que endereços existem.

O pacote nunca resolve um tenant. A rota vive no plano central (vê
[o padrão multi-tenant](/pt/guide/multi-tenant-pattern)). O teu handler tira o
id de `match.params`, **confirma que o tenant existe** e só então entra no plano
do tenant com `tenancy.run`.

## Limites

O `ctx.parse()` (e o `parseInbound()`) aplicam estes limites. Todos os valores
podem ser mudados em `parse`.

| Limite | Default | Quando | Acima do limite |
| --- | --- | --- | --- |
| tamanho do pedido (`signedDriver({ maxRequestBytes })`) | 10 MiB | ao ler o corpo | `413 PAYLOAD_TOO_LARGE` |
| `maxRawBytes` | 10 MiB | antes do parse | `422 INBOUND_MAIL_LIMIT` |
| `maxHeaderBytes` | 64 KiB, no total de todas as partes | durante o parse | `422` |
| `maxDepth` | 8 multiparts aninhados | durante o parse | `422` |
| `maxParts` | 200 (anexos mais corpos) | depois do parse | `422` |
| `maxAttachments` | 50 | depois do parse | `422` |
| `maxAttachmentBytes` | 10 MiB cada, descodificado | depois do parse | `422` |
| `maxTotalAttachmentBytes` | 25 MiB | depois do parse | `422` |
| `maxTextBytes` | 2 MiB cada para texto e html | depois do parse | truncado, `truncated.text`/`truncated.html` marcados |

Uma parte `message/rfc822` aninhada volta como anexo em bruto e nunca é
analisada. Abri-la, tal como expandir um zip, é política da tua aplicação.

**Memória.** O parse é feito todo em memória: o postal-mime descodifica cada
anexo para o seu próprio buffer. Conta com cerca de 3 a 4 vezes o limite do
pedido por pedido concorrente. O default de 10 MiB é dez vezes o default do
`rawBody()`, e é uma escolha deliberada para um endpoint que não está
autenticado até os bytes estarem em memória. Sobe-o explicitamente se precisares.

## Responder depressa, analisar depois

O padrão principal é responder ao relay depressa e fazer o trabalho pesado num
job. Guarda `mail.raw` através do Files e despacha:

```ts
export const ParseInboundMail = defineJob({
  name: 'parse-inbound-mail',
  schema: z.object({ tenantId: z.string(), fileId: z.string(), deliveryKey: z.string() }),
  async handle({ tenantId, fileId }) {
    await tenancy.run(tenantId, async () => {
      const { content } = await files.download(fileId)
      const parsed = await parseInbound(content, { trustedAuthservIds: ['mx.cloudflare.net'] })
      // … arquivar os anexos, registar os veredictos
    })
  },
})

// no handler da rota, dentro de tenancy.run:
const stored = await files.upload(mail.raw, { name: 'message.eml', contentType: 'message/rfc822' })
await ParseInboundMail.dispatch({ tenantId: tenant.id, fileId: stored.id, deliveryKey: mail.deliveryKey })
```

O `parseInbound()` é puro (sem I/O, sem DNS, sem rede), por isso é igualmente
seguro numa `worker_thread`.

## Rate limiting

Acrescenta `meta: { rateLimit: … }` às rotas para que uma origem não consiga
inundar o endpoint. Não vem ligado por omissão, porque o guard de rate limit
avisa quando não há limitador instalado. Um relay envia a partir de poucos
endereços (a saída dos Workers da Cloudflare, o teu MTA), por isso dimensiona o
orçamento para o teu volume real de mail e não para um browser. Vê
[Rate limiting](/pt/guide/security#rate-limiting).

## Authentication-Results e ARC

O `parsed.auth` dá `{ authservId?, spf, dkim, dmarc, dkimDomains, arcSealer? }`.
Cada veredicto é `pass`, `fail`, `softfail`, `neutral`, `none`, `temperror`,
`permerror`, `policy` ou `unknown`.

- Só contam os cabeçalhos `Authentication-Results` cujo authserv-id está em
  `trustedAuthservIds`, comparado sem distinguir maiúsculas. Ganha o de cima.
- **O servidor de confiança tem de remover os cabeçalhos `Authentication-Results`
  que chegam com o seu próprio id** (RFC 8601 §5). O Cloudflare Email Routing e
  os grandes fornecedores de mail fazem-no. Sem isso, um remetente podia
  escrever um cabeçalho com o id de confiança.
- Sem nenhum id de confiança configurado, ou sem nenhum cabeçalho de confiança
  presente, todos os veredictos são `unknown`.
- **Mail reencaminhado.** Quando uma empresa reencaminha o seu próprio
  `invoices@` para o teu endereço, o SPF e muitas vezes o DKIM partem-se, e o
  DMARC falha no teu MTA. Se esse MTA reportar `arc=pass` e o `ARC-Seal` mais
  alto tiver sido feito por um selador em `trustedArcSealers` (por exemplo
  `google.com`), os veredictos vêm do `ARC-Authentication-Results` desse
  selador, que regista o que ele viu antes de reencaminhar. O `arcSealer` indica
  o selador.
- Nada é verificado de novo. As verificações de DKIM e SPF precisam de DNS e
  estão fora do âmbito.

## Anexos para o Files

Não há helper para isto, porque o `Files.upload` já é uma só chamada. Corre-o
dentro do tenant, com a quarentena ligada (`requireScan: true` no plugin do
Files), para que nada seja servido antes de o teu antivírus o libertar:

```ts
for (const attachment of parsed.attachments) {
  await files.upload(attachment.content, {
    name: attachment.filename, // já sanitizado: basename, sem caracteres de controlo nem bidi
    contentType: attachment.declaredContentType, // o que o remetente diz; o Files inspeciona os bytes
    metadata: { source: 'inbound-mail', deliveryKey: mail.deliveryKey },
  })
}
```

## Segurança do HTML

O `parsed.html` é HTML não confiável. O pacote nunca o renderiza, nunca vai
buscar os seus recursos `cid:` ou remotos e nunca o sanitiza. Sanitiza-o antes
de o mostrar, e serve qualquer página que o mostre com uma CSP estrita através
de [cabeçalhos por rota](/pt/guide/security#cabecalhos-por-rota-—-meta-headers).

## Idempotência

Não há dedupe embutido. Uma verificação antes do handler confirmaria a
repetição de um handler que falhou, e o mail perdia-se. Uma chave construída a
partir do `Message-ID` deixaria um remetente suprimir o mail de outro tenant.
Em vez disso, cada entrega leva `mail.deliveryKey`:

- `sha256(raw) + ':' + destinatário`: estável entre repetições do relay, diferente por destinatário, derivada só de dados assinados;
- para um aviso de tamanho excessivo, `'oversize:' + sha256(canonical)`.

Torna os handlers idempotentes sobre ela. Regista a chave só **depois** de o
trabalho ter sido bem sucedido:

```ts
async handler({ mail }) {
  const key = `inbound:${mail.deliveryKey}`
  if (await cache.get(key)) return // já processado
  await process(mail)              // se lançar: 500, o relay repete, nada ficou registado
  await cache.put(key, true, '7d')
}
```

Uma restrição de unicidade na base de dados sobre a chave faz o mesmo sem cache.

A chave é estável quando o relay volta a enviar os mesmos bytes (um relay em
Node que repete o seu `POST`). Com o Worker da Cloudflare acima, uma entrega
falhada é repetida pelo **servidor remetente**: o Email Routing recebe a
mensagem de novo e acrescenta cabeçalhos de trânsito novos (`Received`,
`ARC-Seal`, `Authentication-Results`), por isso a repetição pode trazer uma
chave diferente. Mantém o trabalho do handler atómico (uma transacção, ou
"guardar os bytes e depois enfileirar") para que uma repetição depois de uma
falha nunca o encontre feito a meio.

## Avisos de tamanho excessivo

Quando uma mensagem passa o limite do relay, o Worker acima não a reencaminha.
Envia em vez disso um aviso assinado: um corpo vazio mais
`x-basalt-mail-oversize`. O handler vê `mail.oversize` (o tamanho original) e um
`mail.raw` vazio, e pode avisar a empresa de que a mensagem era grande demais.
O `ctx.parse()` sobre um aviso lança `400 INBOUND_MAIL_MALFORMED`.

## Hooks

| Hook | Payload |
| --- | --- |
| `inbound-mail:rejected` | `{ reason, source, detail?, digest }`: recusada antes do encaminhamento (`unauthorized`, `malformed`, `unsupported-type`, `too-large`, `error`) |
| `inbound-mail:unrouted` | `{ source, digest }`: autenticada, mas nenhuma rota correspondeu |

O `digest` são os primeiros 8 caracteres hex do sha256 do corpo. Os hooks e os
logs nunca levam a mensagem nem os endereços.

## O que não está incluído

Podem chegar mais tarde como drivers separados por trás do contrato público
`InboundMailDriver`. Até lá, põe o fornecedor atrás de um relay que assine o
formato v1.

- **Postmark, Mailgun, SendGrid Inbound Parse.** Basic auth estática ou
  assinaturas sobre campos de formulário, não sobre a mensagem.
- **Amazon SES via SNS.** Precisa de verificação de certificados SNS e de ir
  buscar ao S3, porque o SNS limita o conteúdo a 150 KB.
- **Polling IMAP.** Usa um pequeno poller que chame `signInboundMail`.
- **Expansão de zip ou `.eml` aninhado, sanitização de HTML, nova verificação de
  DKIM/SPF.** São política da aplicação ou precisam de DNS.
- **Vários destinatários num pedido.** Cada destinatário é um POST assinado.

## Códigos de erro

| Status | Código | Quando |
| --- | --- | --- |
| 400 | `INBOUND_MAIL_MALFORMED` | envelope inválido, oversize inválido, mensagem que não se consegue analisar, `parse()` sobre um aviso de tamanho excessivo |
| 401 | `INBOUND_MAIL_UNAUTHORIZED` | assinatura em falta, expirada ou errada. A mensagem é a mesma para todas as causas. |
| 413 | `PAYLOAD_TOO_LARGE` | o pedido passa `maxRequestBytes` |
| 415 | `INBOUND_MAIL_UNSUPPORTED_TYPE` | content type que não é `message/rfc822` nem `application/octet-stream` |
| 422 | `INBOUND_MAIL_LIMIT` | acima de um limite de parse. `details: { limit, max, value? }` |
| 500 | — | o teu handler lançou um erro. O relay repete. |
