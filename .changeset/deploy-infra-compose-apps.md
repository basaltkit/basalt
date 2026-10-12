---
'@basaltkit/deploy': minor
---

Dedicated infra for apps that run in compose: `dockerInfra(app, { project, access: 'containers' })` creates the containers in their own compose project and writes URLs that name them (`myapp-pg:5432`), while migrations and the dump get the `127.0.0.1:<published port>` form; a compose runtime sharing its project with its infra is refused. `compose({ passEnv })` hands `.env` values (a Redis URL with its password) to compose interpolation from memory only. The app role's URL follows a recreated database and keeps its password.
