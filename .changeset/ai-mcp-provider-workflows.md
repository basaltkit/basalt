---
"@basaltkit/ai": minor
---

AI MCP bridge — M2 (provider workflows), RFC 0001 §E / §D.1(2).

- **`@basaltkit/ai`** threads streaming, progress and cancellation through the workflow engine:
  - `GenerateOptions` gains `signal?: AbortSignal`, forwarded into each provider's fetch (Anthropic/Ollama/OpenAI-compatible) and honoured by `fetchWithRetry` (a cancelled request fails immediately, never retried).
  - `createPlan` and `reviewImplementation` (and `runMake`, for consistency) accept `{ signal?, onProgress? }`. With `onProgress`, generation streams via `provider.stream` and emits each fragment; without it, the one-shot `generate` path is unchanged. Cancellation is raced at the workflow layer so it's prompt even if a provider ignores the signal. New exports: `runGeneration`, `generateText`, `withAbort`, `throwIfAborted`, `abortError`, `isAbortError`, and the `WorkflowProgress` / `OnProgress` / `WorkflowRunOptions` types.
  - New `providerEnvFrom(env)` (the env-record form of `providerEnvFromProcess`).
  - New framework-free **`@basaltkit/ai/workflows`** subpath exposing `createProvider`, `providerEnvFrom(FromProcess)`, `createPlan`, `reviewImplementation` (+ types) **without** the `basalt ai` CLI wiring — so dev-only, out-of-process consumers use them without pulling `@basaltkit/core`/`http` into their graph.
- **`@basaltkit/ai-mcp`** (debuts at 0.1.0) gains the two provider-backed tools: `basalt_plan` (natural language → `ArchitecturePlan`) and `basalt_review` (LLM critique → verdict). Both stream MCP `notifications/progress` and honour `notifications/cancelled` via the tool context's `signal`. Provider config is read from the client-supplied `env` and used only in-memory — never logged or persisted. Still boundary-clean: only `@basaltkit/ai` + `@basaltkit/mcp-core`.
