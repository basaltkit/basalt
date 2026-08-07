# @machize/cache-tiered

Driver de cache **multi-nível (tiered)** para o [`@machize/cache`](https://www.npmjs.com/package/@machize/cache): põe uma *near cache* em processo à frente de uma *far cache* partilhada (Redis), cortando round-trips de rede nas chaves quentes. **Zero dependências** — compõe os drivers que já tens. Precisas deste módulo quando o mesmo dado é lido muitas vezes por pedido/instância e queres evitar ir ao Redis de cada vez.

## O que este módulo resolve

Um acesso ao Redis é rápido, mas é rede. Se uma chave é lida centenas de vezes, uma cache em memória (L1) à frente do Redis (L2) elimina quase todas essas idas à rede — mantendo o Redis como fonte partilhada entre instâncias. Este driver faz isso implementando o **mesmo contrato `CacheDriver`**: leituras curto-circuitam na primeira camada com hit e **preenchem** as camadas mais rápidas; escritas e invalidações **espalham-se** por todas.

## Instalação

```bash
pnpm add @machize/cache-tiered @machize/cache
```

Sem dependências de runtime além do `@machize/cache`.

## Uso

```ts
import { cachePlugin, MemoryCacheDriver, RedisCacheDriver } from '@machize/cache'
import { TieredCacheDriver } from '@machize/cache-tiered'

cachePlugin({
  driver: new TieredCacheDriver({
    layers: [new MemoryCacheDriver(), RedisCacheDriver.fromUrl(process.env.REDIS_URL!)],
    backfillTtlMs: 30_000, // a L1 guarda no máximo 30s um valor vindo do Redis
  }),
})
```

Tudo o resto (`cache.remember`, tags, `flush`) funciona igual — o `TieredCacheDriver` é transparente.

## Como funciona

- **`get`** — percorre as camadas (rápida → lenta); ao primeiro hit, devolve e **preenche** as camadas mais rápidas que falharam (com `backfillTtlMs`, já que o TTL restante não é conhecido na camada lenta).
- **`set`** — escreve em **todas** as camadas com o mesmo TTL e tags.
- **`delete` / `flushPrefix` / `flushTags`** — espalham-se por todas as camadas.
- **Sem lacunas** — o que as tuas camadas suportam (tags, flush por prefixo), este driver suporta, por delegação.

> Coerência entre instâncias: invalidações locais só limpam a L1 **desta** instância. Para invalidar a L1 de todos os nós, dispara a invalidação a partir de um evento partilhado (ou usa um `backfillTtlMs` curto para limitar a janela de dados obsoletos).

## Opções

| Opção | Default | Descrição |
|---|---|---|
| `layers` | — (obrigatório) | Camadas ordenadas da mais rápida para a mais lenta, ex.: `[memory, redis]`. |
| `backfillTtlMs` | `60000` | TTL aplicado ao preencher uma camada rápida a partir de um hit lento. `null` = sem expiração. |

## Como se liga aos outros módulos

- **`@machize/cache`** — este é um driver desse pacote; a API (`Cache`, `cachePlugin`, `remember`, tags) vem de lá.
- Compõe-se com `MemoryCacheDriver` e `RedisCacheDriver` (do core do cache).
