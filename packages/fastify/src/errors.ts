// HTTP errors are framework-neutral (see @machize/http); re-exported for
// back-compat with `import { HttpError } from '@machize/fastify'`.
export { HttpError, RequestValidationError, type ValidationIssue } from '@machize/http'
