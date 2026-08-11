---
layout: home

hero:
  name: Basalt
  text: O toolkit completo para construir SaaS em Node.js
  tagline: Multi-tenancy, autenticação, faturação, permissões, filas e auditoria — integrados de ponta a ponta, self-hosted, sem dependência de fornecedor.
  actions:
    - theme: brand
      text: Começar
      link: /pt/guide/getting-started
    - theme: alt
      text: Ver no GitHub
      link: https://github.com/Zebedeu/basalt

features:
  - title: Multi-tenancy de primeira classe
    details: Resolvers por subdomínio, domínio, cabeçalho e rota. Cache, storage, filas, logger e auditoria isolam-se por tenant automaticamente através do contexto do pedido.
  - title: Baterias incluídas
    details: Autenticação com rotação de refresh, permissões por papéis com wildcards, faturação de subscrições com limites de funcionalidades — na tua base de dados, não num serviço de terceiros.
  - title: TypeScript de ponta a ponta
    details: Os esquemas Zod fluem da rota para o handler e para um cliente SDK totalmente inferido. Sem decorators, sem reflect-metadata — funciona em qualquer bundler e runtime.
  - title: Fastify-first, não Fastify-locked
    details: Um núcleo agnóstico ao framework com um adaptador Fastify oficial. O domínio nunca importa a camada HTTP, por isso sobrevive a qualquer servidor.
---
