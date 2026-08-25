# Benchmarks

> *Quanto custa o core neutro do Basalt sobre o servidor HTTP cru?*

Resposta curta: **no Fastify, cerca de 10–17% de overhead de débito** — pelo
container, arranque de plugins, contexto de pedido, metadados de rota e pipeline
de validação. Significativo mas modesto — trocas isso por todo o toolkit
`@basaltkit/*`. O harness reprodutível vive em
[`apps/bench`](https://github.com/basaltkit/basalt/tree/main/apps/bench).

## Método

As **mesmas duas rotas** são definidas uma vez com o `route()` agnóstico ao
adaptador do `@basaltkit/http` e servidas de quatro formas — três adaptadores
Basalt mais um Fastify puro escrito à mão:

- `GET /health` — handler trivial, mede o overhead puro da framework
- `POST /echo` — corpo validado com Zod, mede o caminho de validação

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

Uma comparação justa é fácil de estragar, por isso o harness:

- **Corre cada servidor no seu próprio processo** — nenhum socket, GC, JIT ou
  estado do event-loop transita, por isso o servidor medido *por último* não é
  penalizado pelos anteriores. (Correr tudo num só processo enviesa a média e
  pode até fazer um wrapper parecer *mais rápido* que o servidor que embrulha.)
- **Faz warm-up** na concorrência de medição e descarta-o.
- **Corre várias iterações e reporta a mediana**, com cooldowns e um shutdown
  limpo entre servidores.
- **Reporta latência p50 (mediana) e p99, nunca a média aritmética** — a média é
  enviesada por meia dúzia de outliers. Uma contagem de `errors` sinaliza
  execuções não-fiáveis.

## Resultados

`50 ligações · 10s · mediana de 3 iterações` em Apple Silicon / Node 24. **Os
números absolutos dependem da máquina — lê os intervalos entre linhas, não os
dígitos.** Zero erros em todas as execuções.

### `GET /health`

| servidor             |  req/seg | vs #1 | p50 | p99 |
| -------------------- | -------: | ----: | --: | --: |
| fastify puro         |   59,943 |  100% | <1ms | 1ms |
| **Basalt · fastify** |   49,884 |   83% | <1ms | 2ms |
| Basalt · express     |   32,136 |   54% | 1ms | 3ms |
| Basalt · hono        |   26,665 |   44% | 1ms | 4ms |

### `POST /echo` (validado com Zod)

| servidor             |  req/seg | vs #1 | p50 | p99 |
| -------------------- | -------: | ----: | --: | --: |
| fastify puro         |   39,114 |  100% | 1ms | 5ms |
| **Basalt · fastify** |   34,474 |   88% | 1ms | 5ms |
| Basalt · express     |   27,228 |   70% | 1ms | 3ms |
| Basalt · hono        |   18,987 |   49% | 2ms | 5ms |

## Como ler os números

- **O Basalt sobre Fastify mantém ~83–88% do débito do Fastify cru** — um
  overhead de ~10–17% pelo container, DI, ciclo de vida de plugins, contexto de
  pedido e roteamento por metadados. O Fastify puro é a linha mais rápida, como
  deve ser: o Basalt embrulha-o, por isso nunca o pode ultrapassar.
- **O Express e o Hono são mais lentos porque esses runtimes são mais lentos** —
  não porque o Basalt custe mais neles. A camada Basalt é *idêntica* nos três
  adaptadores (os mesmos objetos `route()`); o intervalo que vês é o custo por
  pedido de cada adaptador. Escolhe um adaptador pelo seu ecossistema, não por um
  número que o Basalt mudaria.
- Mesmo a linha mais lenta serve **~19 mil pedidos validados por segundo num
  portátil** — bem acima do que uma API SaaS multi-tenant típica precisa. A tua
  base de dados e a rede são o teto muito antes da framework.

## Corre tu mesmo

```bash
pnpm --filter @basaltkit/bench bench
# knobs (com defaults):
BENCH_CONNECTIONS=50 BENCH_DURATION=10 BENCH_ITERATIONS=3 BENCH_WARMUP=3 \
  pnpm --filter @basaltkit/bench bench
```
