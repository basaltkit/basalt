# Configuração

O [`@basaltkit/config`](/reference/packages/config) dá à tua app **um** lugar para as
definições — endereços, portas, opções de driver — lidas por um dot-path como
`config.get('mail.smtp.port')`. Pede uma chave que não existe e ele lança um erro
claro em vez de devolver `undefined` em silêncio, por isso má configuração aparece
cedo.

## Registar e ler

Põe as definições num objeto, organizadas por área, e regista o `configPlugin`.
Qualquer plugin busca o repositório pelo token `CONFIG`:

```ts
import { createApp, definePlugin } from '@basaltkit/core'
import { CONFIG, configPlugin } from '@basaltkit/config'

const settings = {
  app: { name: 'my-app' },
  mail: { from: 'hi@basalt.dev', smtp: { port: 587 } },
}

const mailPlugin = definePlugin({
  name: 'app:mail',
  dependsOn: ['basalt:config'], // o config regista-se primeiro
  register({ container }) {
    const config = container.get(CONFIG)
    const from = config.get('mail.from')            // 'hi@basalt.dev'
    const port = config.get('mail.smtp.port', 25)   // 587 (ou o fallback se faltar)
  },
})

await createApp({ plugins: [configPlugin(settings), mailPlugin] }).boot()
```

## Leituras que falham alto

```ts
config.get('mail.from')          // → 'hi@basalt.dev'
config.get('mail.replyTo', null) // → null  (fallback explícito, sem throw)
config.get('mail.replyTo')       // → lança ConfigKeyError — a chave falta
config.has('queue.driver')       // → boolean, sem throw
```

Uma chave em falta **sem** fallback lança `ConfigKeyError` — apanhas o erro no boot,
não como um `undefined` no fundo de um handler. Emparelha com
[`@basaltkit/env`](/pt/guide/getting-started) para carregar segredos/valores por host
do ambiente e fundi-los no objeto de definições.
