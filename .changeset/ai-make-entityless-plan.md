---
'@basaltkit/ai': patch
---

`ai:make` no longer asks for confirmation and then fails with "the plan has no entity to generate" when the plan has nothing to scaffold (e.g. wiring an installed package): it stops before the prompt with "Nothing to scaffold" (exit 0), and `ai:plan` no longer suggests `ai:make` for such a plan.
