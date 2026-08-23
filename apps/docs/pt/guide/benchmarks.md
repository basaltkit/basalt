# Benchmarks

> *Quanto custa o core neutro do Basalt sobre o servidor HTTP cru?*

Resposta curta: **no Fastify, cerca de 5–10%.** O container, o arranque de
plugins, os metadados de rota e o pipeline de validação são praticamente
gratuitos. O harness reprodutível vive em
[`apps/bench`](https://github.com/Zebedeu/basalt/tree/main/apps/bench).

## Método

As **mesmas duas rotas** são definidas uma vez com o `route()` agnóstico ao
adaptador do `@basaltkit/http` e servidas de quatro formas — três adaptadores
Basalt mais um Fastify puro escrito à mão como baseline:

- `GET /health` — handler trivial, mede o overhead puro da framework
- `POST /echo` — corpo validado com Zod, mede o caminho de validação

Cada servidor é aquecido e depois martelado com
[autocannon](https://github.com/mcollina/autocannon) a 50 ligações concorrentes
durante 10 segundos.

```ts
// src/routes.ts — uma definição, todos os adaptadores
export const routes = [
  route({ method: 'GET', url: '/health', async handler() { return { ok: true } } }),
  route({
    method: 'POST', url: '/echo',
    body: z.object({ name: z.string(), n: z.number() }),
    async handler({ body }) { return { hello: body.name, doubled: body.n * 2 } },
  }),
]
```

## Resultados

`50 ligações · 10s` em Apple Silicon / Node 22. **Os números absolutos dependem
da máquina — lê os intervalos entre linhas, não os dígitos.**

### `GET /health`

| servidor             |  req/seg | vs #1 | méd | p99 |
| -------------------- | -------: | ----: | --: | --: |
| fastify puro         |   31,971 |  100% | 1.06ms | 2ms |
| **Basalt · fastify** |   30,337 |   95% | 1.12ms | 3ms |
| Basalt · express     |   21,656 |   68% | 1.98ms | 4ms |
| Basalt · hono        |   20,498 |   64% | 2.07ms | 3ms |

### `POST /echo` (validado com Zod)

| servidor             |  req/seg | vs #1 | méd | p99 |
| -------------------- | -------: | ----: | --: | --: |
| fastify puro         |   25,429 |  100% | 1.29ms | 5ms |
| **Basalt · fastify** |   22,990 |   90% | 1.59ms | 5ms |
| Basalt · express     |   16,434 |   65% | 2.53ms | 9ms |
| Basalt · hono        |   14,607 |   57% | 3.03ms | 5ms |

## Como ler os números

- **O Basalt mantém ~90–95% do débito do Fastify cru.** O core neutro acrescenta
  um overhead de um dígito percentual — não pagas de forma significativa pelo
  container, DI, ciclo de vida de plugins ou roteamento por metadados.
- **O Express e o Hono são mais lentos porque esses runtimes são mais lentos** —
  não porque o Basalt custe mais neles. A camada Basalt é *idêntica* nos três
  adaptadores (os mesmos objetos `route()`); o intervalo que vês é o custo por
  pedido de cada adaptador. Escolhe um adaptador pelo seu ecossistema, não por um
  número que o Basalt mudaria.
- Mesmo a linha mais lenta serve **~14 mil pedidos validados por segundo num
  portátil** — bem acima do que uma API SaaS multi-tenant típica precisa. A tua
  base de dados e a rede são o teto muito antes da framework.

## Corre tu mesmo

```bash
pnpm --filter @basaltkit/bench bench
BENCH_DURATION=20 BENCH_CONNECTIONS=100 pnpm --filter @basaltkit/bench bench
```
