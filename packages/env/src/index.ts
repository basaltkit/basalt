import { MachizeError } from '@machize/core'
import { z } from 'zod'

export class EnvValidationError extends MachizeError {
  constructor(readonly report: string[]) {
    super(
      'ENV_INVALID',
      `Invalid environment variables:\n${report.map((line) => `  - ${line}`).join('\n')}`,
    )
  }
}

export interface DefineEnvOptions {
  /** Source of the variables. Default: process.env */
  source?: Record<string, string | undefined>
}

/**
 * Validates and types environment variables. Aggregates ALL errors into a single
 * report instead of failing one variable at a time.
 *
 * export const env = defineEnv({
 *   DATABASE_URL: z.string().url(),
 *   PORT: z.coerce.number().default(3000),
 * })
 */
export function defineEnv<TShape extends z.ZodRawShape>(
  shape: TShape,
  options: DefineEnvOptions = {},
): z.infer<z.ZodObject<TShape>> {
  const source = options.source ?? process.env
  const result = z.object(shape).safeParse(source)

  if (!result.success) {
    const report = result.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    )
    throw new EnvValidationError(report)
  }

  return Object.freeze(result.data)
}

export { secret, type SecretOptions } from './secret.js'
