# Segurança

O Basalt é **seguro por omissão** na borda HTTP e fail-closed nos segredos.
Tudo aqui é zero-dependências e ligado através do ciclo de vida dos plugins.

## Proteção de borda — `securityPlugin`

Um só plugin cobre rate limiting, CORS e cabeçalhos de resposta seguros. Os três
estão ligados por omissão com valores sensatos.

```ts
import { securityPlugin } from '@basaltkit/fastify'

securityPlugin({
  rateLimit: { limit: 100, windowMs: 60_000 },      // 100 req / minuto / IP
  cors: { origin: ['https://app.example.com'], credentials: true },
  headers: true,                                     // defaults seguros
})
```

### Rate limiting

Um limitador de janela fixa chaveado pelo IP do cliente (substitui com `key`).
Pedidos bloqueados recebem `429 RATE_LIMITED` com `Retry-After`, e cada resposta
carrega `X-RateLimit-Limit` / `-Remaining` / `-Reset`.

```ts
securityPlugin({
  rateLimit: {
    limit: 20,
    windowMs: 10_000,
    key: (req) => req.headers['x-api-key'] as string ?? req.ip,
    skip: (req) => req.url.startsWith('/livez'),
  },
})
```

O store por omissão é em memória (`MemoryRateLimitStore`). Para múltiplas
instâncias, implementa a interface `RateLimitStore` sobre Redis — o mesmo padrão
de driver usado por `@basaltkit/cache`.

### CORS

`origin` aceita `true` (refletir), uma string, um array de allow-list, ou um
predicado. Os pedidos de preflight `OPTIONS` são respondidos automaticamente.

### Cabeçalhos seguros

`headers: true` define HSTS, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` e
`Cross-Origin-Opener-Policy: same-origin`. Passa um objeto para personalizar (p.
ex. uma `contentSecurityPolicy` para superfícies HTML) ou `false` para desativar.

## Segredos fail-closed — `secret()`

O incidente de produção mais comum é enviar uma chave de assinatura placeholder.
`secret()` torna isso impossível:

```ts
import { defineEnv, secret } from '@basaltkit/env'

export const env = defineEnv({
  APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' }),
})
```

- **Desenvolvimento**: usa `devDefault` quando não definido — a app simplesmente corre.
- **Produção** (`NODE_ENV=production`): a variável é **obrigatória**, tem de
  cumprir um comprimento mínimo, e é **rejeitada se parecer um placeholder**
  (`change-me`, `secret`, `password`, …). Caso contrário a app recusa arrancar.

## Bloqueio por força bruta

`@basaltkit/auth` limita logins falhados por email logo à partida — sem qualquer
ligação necessária. Após demasiadas falhas dentro de uma janela deslizante,
`login()` lança `AccountLockedError` (HTTP 429) mesmo com a password correta; um
sucesso limpa o contador.

```ts
import { authPlugin, LoginThrottle } from '@basaltkit/auth'

authPlugin({
  users,
  secret: env.APP_SECRET,
  // por omissão 5 tentativas / 15 min; personaliza ou desativa:
  loginThrottle: new LoginThrottle({ maxAttempts: 10, windowMs: 5 * 60_000 }),
  // loginThrottle: false, // para desligar
})
```

## Mutações idempotentes — `idempotencyPlugin`

Retries seguros para `POST`: um cliente que envia uma `Idempotency-Key` recebe a
**mesma** resposta replicada num retry, por isso uma ligação caída nunca cobra um
cartão duas vezes.

```ts
import { idempotencyPlugin } from '@basaltkit/fastify'

idempotencyPlugin() // protege POST por omissão
```

- Repetir com a mesma chave → a resposta em cache, com `Idempotent-Replayed: true`.
- Uma repetição enquanto a primeira ainda está em curso → `409 IDEMPOTENCY_CONFLICT`.
- Respostas `5xx` **não** são colocadas em cache, por isso falhas genuínas
  continuam repetíveis.
- As chaves têm escopo por método + rota, por isso a mesma chave em dois endpoints
  não pode colidir.

## Cadeia de fornecimento

O CI corre `pnpm audit` (severidade alta), **CodeQL** SAST, e o **Dependabot**
mantém dependências e Actions atualizadas. Os releases publicam no npm com
**provenance** (`NPM_CONFIG_PROVENANCE`) via changesets — sem tokens manuais ou
OTP no pipeline.
