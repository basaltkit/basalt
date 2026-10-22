---
'@basaltkit/deploy-ui': minor
---

An older server deploy is now explained, and each target shows which app it is. When the server's `@basaltkit/deploy` is behind a feature the page uses (commit lists 0.8.0, source 0.9.0), the version in the target bar turns amber. **Status** and **Check connection** list what is missing, give the exact `pnpm add -D @basaltkit/deploy@^…` and note that the first deploy still runs the old version. The bar and **Check connection** also show the app and its source (`github.com/acme/app (main)`) from the new `StatusResult.source`. All of this is in English and Portuguese.
