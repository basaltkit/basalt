import { MachizeError } from '@machize/core'
import { z } from 'zod'

export class EnvValidationError extends MachizeError {
  constructor(readonly report: string[]) {
    super(
      'ENV_INVALID',
      `Variáveis de ambiente inválidas:\n${report.map((line) => `  - ${line}`).join('\n')}`,
    )
  }
}

export interface DefineEnvOptions {
  /** Fonte das variáveis. Default: process.env */
  source?: Record<string, string | undefined>
}

/**
 * Valida e tipa variáveis de ambiente. Agrega TODOS os erros num único
 * relatório em vez de falhar uma variável por vez.
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
      (issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`,
    )
    throw new EnvValidationError(report)
  }

  return Object.freeze(result.data)
}
