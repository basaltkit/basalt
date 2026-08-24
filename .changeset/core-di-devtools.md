---
'@basaltkit/core': minor
---

Add DI-graph devtools on the container. `container.describe()` returns a static
snapshot of every reachable binding (token, lifetime, whether it's been built).
`container.enableGraph()` turns on passive dependency-graph recording (off by
default — zero overhead); `container.dependencyGraph()` then returns the
`A depends on B` edges observed during real resolutions, and
`renderDependencyGraph(graph)` renders it as Mermaid for docs or debugging.
