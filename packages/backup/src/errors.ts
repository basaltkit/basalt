import { BasaltError } from '@basaltkit/core'

export class BackupConfigError extends BasaltError {
  constructor(message: string) { super('BACKUP_CONFIG_INVALID', message) }
}

export class BackupCommandError extends BasaltError {
  constructor(command: string, cause?: unknown) {
    super('BACKUP_COMMAND_FAILED', `PostgreSQL command failed: ${command}`, cause instanceof Error ? { cause } : undefined)
  }
}

export class BackupNotFoundError extends BasaltError {
  constructor(id: string) { super('BACKUP_NOT_FOUND', `Backup "${id}" was not found.`) }
}

export class BackupRestoreRejectedError extends BasaltError {
  constructor(message: string) { super('BACKUP_RESTORE_REJECTED', message) }
}

export class BackupTenantRequiredError extends BasaltError {
  constructor() { super('BACKUP_TENANT_REQUIRED', 'A tenant id is required for this backup target.') }
}
