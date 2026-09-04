---
'@basaltkit/auth': patch
---

`authRoutes()` accepts a password policy.

The rule was `min(8)`, fixed, with no way to change it. Eight characters is the
2012 minimum, and an application holding case files or medical records has every
reason to ask for more — but the only way was to stop using these routes.

One application instead reached into the route's Zod object and swapped the
`password` field while preserving the rest. That works, and depends on the
internal shape of a body it does not own: any change here breaks it silently,
with no compile error.

```ts
authRoutes({ password: { minLength: 12 } })

// or the schema itself, for rules a length cannot express
authRoutes({
  password: z.string().min(10).refine((p) => /[^a-zA-Z0-9]/.test(p), 'needs a symbol'),
})
```

It applies to `/auth/password/reset` as well as `/auth/register`. Covering
register and leaving reset behind would let anyone walk a strong password back
down to eight characters through "forgot password" — a loophole worse than
having no option at all.

The default stays `min(8)`: raising it would start rejecting passwords that
already work.
