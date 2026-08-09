// HTTP errors are framework-neutral (see @basaltkit/http); re-exported for
// back-compat with `import { HttpError } from '@basaltkit/fastify'`.
export { HttpError, RequestValidationError, type ValidationIssue } from '@basaltkit/http'
