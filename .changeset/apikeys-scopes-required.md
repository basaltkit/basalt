---
"@basaltkit/auth": minor
"@basaltkit/api-keys-ui": patch
---

**API keys need explicit scopes (#581).** `ApiKeys.issue()` used to fall back to `['*']` when `scopes` was omitted, which made the key as powerful as its owner by accident.

- **`@basaltkit/auth`:** `IssueApiKeyInput.scopes` is required, in the type and at run time (`ApiKeyInputError`, 400), and the body of `POST /apikeys` requires `scopes` too. `['*']` still works, written out, and `[]` is a valid choice. `PATCH /apikeys/:id` is unchanged.
- **`@basaltkit/api-keys-ui`:** the create form requires at least one scope and says that `*` means every permission. An empty field used to create a full-power key.

**Breaking in a minor, by decision:** add `scopes: ['*']` wherever a full-power key is really intended.
