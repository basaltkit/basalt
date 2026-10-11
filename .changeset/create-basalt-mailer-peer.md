---
"create-basalt": patch
---

A new app lists `@basaltkit/mailer` in `devDependencies` next to `@basaltkit/testing`, whose 3.0 takes it as a peer (`fakeMailer()` binds the app's own `MAILER` token). A new test checks every flag combination: each required `@basaltkit/*` peer of a scaffolded package is in the app's manifest, so a package manager that does not install peers on its own still gets a loadable app.
