---
"@basaltkit/cli": minor
---

Add the `dev`, `upgrade` and `publish` built-in commands.

- **`dev [--entry=<file>]`** — runs the app with watch + auto-restart, delegating to `tsx watch` when resolvable, else `node --watch` (with `--experimental-strip-types` for `.ts`). Entry is probed (`src/main.ts` → `src/index.ts` → …) or given via `--entry`. Exposes the pure `resolveDevEntry` / `resolveDevRunner`.
- **`upgrade [--dir] [--dry] [--only=<id>]`** — a versioned codemod engine (`Migration` / `runUpgrade` / `UpgradeFs`) with the `rename-machize-scope` migration (`@machize/*` → `@basaltkit/*`) shipped. `--dry` previews without writing.
- **`publish [<id>] [--dir] [--force]`** — copies bundled stub groups (`dockerfile`, `ci`, `editorconfig`) into the app à la `vendor:publish`; skips existing files unless `--force`. Exposes `Publishable` / `runPublish` / `PublishFs`.

All three are added to `builtinCommands()`, so every `runCli` app gets them.
