---
"@basaltkit/deploy-ui": minor
---

Commit lists in the UI. **Plan & deploy** shows what will go out, and warns when the branch was rewritten or the commit is held. **History** shows each release's subject, and a row opens the commits it brought in (read once and cached). **Roll back** previews the commits that would leave production and lists them in the confirmation. The rollback request itself is unchanged, and the run says so if the deploy chose a different commit than the preview. Everything is rendered as text. An unavailable list, or an older `@basaltkit/deploy` on the server, is said plainly and never disables an action.
