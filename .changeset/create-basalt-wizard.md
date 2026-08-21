---
"create-basalt": minor
---

Add a rich interactive wizard.

Running `create-basalt` with no name in a terminal now launches a guided, dependency-free wizard: an intro banner, a **starting-point preset** (SaaS starter / API only / Full stack / Minimal / Custom), an arrow-key **feature multiselect** on the custom path, a package-manager select (with the Web-UI-forces-pnpm rule), and a **summary + confirm** step before scaffolding. Passing a name, `--yes`, or piping input (CI) keeps the flag-driven path unchanged.

Exposes the testable core: `runWizard(prompter, options)`, `validateProjectName`, `PRESETS`/`FEATURES`, and the `Prompter` abstraction with `ttyPrompter()` (raw-mode arrow keys) and `scriptedPrompter()` (tests).
