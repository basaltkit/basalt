import { MachizeError } from '@machize/core'

export interface ValidationIssue {
  path: string
  message: string
}

/** Falha de validação de body/query/params — vira resposta 400 padronizada. */
export class RequestValidationError extends MachizeError {
  constructor(
    readonly part: 'body' | 'query' | 'params',
    readonly issues: ValidationIssue[],
  ) {
    super('HTTP_VALIDATION', `Validação falhou em ${part}`)
  }
}

/**
 * Erro HTTP intencional lançável de qualquer camada:
 * `throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Projeto não existe')`
 */
export class HttpError extends MachizeError {
  constructor(
    readonly status: number,
    code: string,
    message: string,
  ) {
    super(code, message)
  }
}
