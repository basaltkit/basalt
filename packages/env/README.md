# @machize/env

Validação tipada das variáveis de ambiente com [Zod](https://zod.dev): a aplicação falha logo no arranque, com um relatório único de **todos** os problemas, em vez de rebentar mais tarde a meio de um pedido. Precisas dele em qualquer aplicação que leia `process.env` (ou seja, praticamente todas).

## O que este módulo resolve

Uma **variável de ambiente** é um valor definido fora do código — no terminal, num ficheiro `.env` ou no painel do servidor — que a aplicação lê em `process.env`. É a forma habitual de passar coisas como o endereço da base de dados (`DATABASE_URL`) ou chaves secretas. O problema: `process.env` devolve sempre texto (ou `undefined`), sem qualquer garantia. Se te esqueces de definir uma variável, o erro só aparece muito depois, num sítio difícil de perceber.

O `@machize/env` resolve isto com a função `defineEnv`: declaras o formato esperado de cada variável usando um **schema** (uma descrição validável do formato dos dados, escrita com a biblioteca Zod) e ele valida tudo no momento em que o módulo é carregado. Se algo estiver errado, lança um erro com o relatório completo — todas as variáveis em falta ou inválidas de uma vez, e não uma de cada vez. O objeto devolvido é tipado (o TypeScript sabe que `env.PORT` é um número) e congelado (ninguém o pode alterar por engano).

Inclui ainda o helper `secret()`, um schema especial para segredos (chaves de API, chaves de assinatura de JWT, …) com uma política *fail-closed* em produção: em desenvolvimento aceita um valor por omissão para arrancares logo, mas em produção exige um segredo real — recusa valores em falta, curtos ou com ar de "placeholder" (`change-me`, `secret`, `password`, …).

## Instalação

```bash
pnpm add @machize/env zod
```

O `zod` é uma *peer dependency* (tens de o instalar tu; são aceites as versões `^3.24.0` e `^4.0.0`). O `@machize/core` vem como dependência automática.

## Começar em 5 minutos

1. Cria um ficheiro `src/env.ts` no teu projeto.
2. Declara as variáveis que a aplicação precisa.
3. Importa `env` em qualquer lado, com tipos garantidos.

```ts
// src/env.ts
import { defineEnv, secret } from '@machize/env'
import { z } from 'zod'

export const env = defineEnv({
  // texto obrigatório em formato URL:
  DATABASE_URL: z.string().url(),
  // texto convertido para número, com valor por omissão:
  PORT: z.coerce.number().default(3000),
  // segredo: em dev usa o devDefault; em produção exige um valor real
  APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' }),
})
```

```ts
// src/servidor.ts
import { env } from './env.js'

console.log(env.DATABASE_URL) // string — garantido
console.log(env.PORT)         // number — já convertido (ex.: 3000)
```

Se arrancares sem `DATABASE_URL`, vês imediatamente algo como:

```
EnvValidationError: Invalid environment variables:
  - DATABASE_URL: Required
```

Passo a passo do que acontece: (1) o `defineEnv` lê `process.env`; (2) valida cada variável com o schema correspondente; (3) se houver erros, junta-os todos num `EnvValidationError`; (4) se estiver tudo bem, devolve um objeto tipado e congelado (`Object.freeze`).

## Guia de utilização

### Validar com todos os erros de uma vez

Ao contrário de validar variável a variável, o relatório traz tudo junto — corriges o `.env` numa só ronda:

```ts
import { defineEnv, EnvValidationError } from '@machize/env'
import { z } from 'zod'

try {
  defineEnv({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    PORT: z.coerce.number(),
  })
} catch (error) {
  if (error instanceof EnvValidationError) {
    console.error(error.code)   // 'ENV_INVALID'
    console.error(error.report) // ['DATABASE_URL: Required', 'REDIS_URL: Required', 'PORT: ...']
  }
}
```

### Fonte alternativa (testes)

Por omissão, o `defineEnv` lê `process.env`. Em testes, passa a tua própria fonte:

```ts
import { defineEnv } from '@machize/env'
import { z } from 'zod'

const env = defineEnv(
  { DATABASE_URL: z.string().url() },
  { source: { DATABASE_URL: 'postgres://localhost:5432/app' } },
)
```

### Segredos com `secret()`

O `secret()` devolve um schema Zod de `string` com três proteções (a decisão dev/produção é feita lendo `process.env.NODE_ENV` no momento da validação):

1. **Obrigatório em produção** — o `devDefault` nunca se aplica com `NODE_ENV=production`.
2. **Rejeita placeholders em produção** — valores como `change-me`, `changeme`, `placeholder`, `example`, `secret`, `password`, `default`, `test`, `xxxx…`, `0000…` são recusados (em desenvolvimento são aceites, por conveniência).
3. **Comprimento mínimo em qualquer ambiente** — 16 caracteres por omissão.

```ts
import { defineEnv, secret } from '@machize/env'

export const env = defineEnv({
  // arranca logo em dev; em produção exige um valor real:
  APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' }),
  // sem devDefault: obrigatório em todos os ambientes; mínimo 32 caracteres:
  JWT_SIGNING_KEY: secret({ minLength: 32 }),
})
```

Resultado prático: um projeto novo corre "out of the box" em desenvolvimento e **recusa-se a arrancar** em produção até definires segredos reais.

### Ligar ao resto da aplicação Machize

Padrão recomendado: valida o ambiente primeiro e usa-o para construir a configuração da aplicação.

```ts
import { createApp } from '@machize/core'
import { configPlugin } from '@machize/config'
import { defineEnv, secret } from '@machize/env'
import { z } from 'zod'

const env = defineEnv({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3000),
  APP_SECRET: secret({ devDefault: 'dev-only-insecure-secret-value' }),
})

await createApp({
  plugins: [
    configPlugin({
      app: { port: env.PORT, secret: env.APP_SECRET },
      db: { url: env.DATABASE_URL },
    }),
  ],
}).boot()
```

## Referência da API

### `defineEnv(shape, options?)`

Valida e tipa as variáveis de ambiente. Devolve `z.infer<z.ZodObject<TShape>>` — um objeto **congelado** com os valores validados e convertidos. Lança `EnvValidationError` se alguma variável falhar.

| Parâmetro | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `shape` | `z.ZodRawShape` (objeto `{ NOME: schemaZod }`) | sim | — | Um schema Zod por variável. |
| `options.source` | `Record<string, string \| undefined>` | não | `process.env` | Fonte dos valores (útil em testes). |

### `secret(options?)`

Devolve `z.ZodType<string>` — um schema Zod para variáveis secretas, *fail-closed* em produção (ver regras acima).

| Opção (`SecretOptions`) | Tipo | Obrigatório? | Default | Descrição |
|---|---|---|---|---|
| `minLength` | `number` | não | `16` | Comprimento mínimo, em todos os ambientes. |
| `devDefault` | `string` | não | — | Valor usado fora de produção quando a variável não está definida. Em produção nunca se aplica. |

Nota: o `devDefault` também tem de cumprir o `minLength` — a validação corre sobre ele.

### `EnvValidationError`

Erro lançado por `defineEnv`. Estende `MachizeError` do `@machize/core`.

| Propriedade | Tipo | Descrição |
|---|---|---|
| `code` | `string` | Sempre `'ENV_INVALID'`. |
| `report` | `string[]` | Uma linha por problema, no formato `NOME_DA_VARIAVEL: mensagem`. |
| `message` | `string` | Relatório completo formatado, pronto a imprimir. |

## Erros comuns e soluções (FAQ)

**"Invalid environment variables" ao arrancar** — Lê as linhas do relatório: cada uma diz a variável e o problema. Define as variáveis em falta no teu ficheiro `.env` (ou no ambiente do servidor) e arranca de novo. Nota: o `@machize/env` não lê ficheiros `.env` sozinho — usa `node --env-file=.env` (Node 20+) ou uma ferramenta como `dotenv` antes de o módulo `env.ts` ser importado.

**"is required in production" para uma variável com `devDefault`** — É o comportamento pretendido: com `NODE_ENV=production` o `devDefault` é ignorado. Define o valor real no ambiente de produção.

**"looks like a placeholder — set a strong, unique secret in production"** — O valor do segredo contém uma palavra proibida (`secret`, `password`, `change-me`, …). Gera um valor aleatório real, por exemplo: `openssl rand -hex 32`.

**"must be at least 16 characters"** — O segredo é demasiado curto. Usa um valor mais longo ou, se tiveres mesmo uma razão, baixa o limite com `secret({ minLength: 8 })` (não recomendado).

**`env.PORT` vem como texto e não como número** — Usa `z.coerce.number()` em vez de `z.number()`: as variáveis de ambiente são sempre texto e o `coerce` faz a conversão.

**Quero alterar `env.X` em runtime mas dá erro** — O objeto devolvido é congelado com `Object.freeze` de propósito: o ambiente é só de leitura. Se precisas de valores mutáveis, usa o `ConfigRepository` do `@machize/config`.

**A validação passou em dev mas falhou em produção com o mesmo `.env`** — O `secret()` decide pelas regras de produção quando `NODE_ENV=production`. Confirma qual é o `NODE_ENV` em cada ambiente.

## Como se liga aos outros módulos

- **`@machize/core`** — o `EnvValidationError` estende `MachizeError` (com o `code` estável `ENV_INVALID`, tal como os restantes erros do ecossistema). O `defineEnv` corre normalmente **antes** do `createApp`, para a aplicação nem sequer tentar arrancar com ambiente inválido.
- **`@machize/config`** — par natural: o `defineEnv` valida o mundo exterior (variáveis de ambiente) e o `configPlugin` distribui esses valores, já organizados por namespaces, a todos os plugins através do container.
- **`@machize/events`** — sem ligação direta; usa o `env` para configurar, por exemplo, o destino do `dispatch` do outbox (URLs de webhooks, chaves de API).
