import { BasaltError, createToken, ctx, definePlugin, ensureMetadata, parseDuration, type Container, type DurationInput } from '@basaltkit/core'
import { STORAGE, type Disk } from '@basaltkit/storage'
import { route, type BasaltRoute } from '@basaltkit/http'
import { z } from 'zod'
import { Files, type FileValidation, type FilesOptions } from './files.js'
import type { FileRecord, FileStore } from './store.js'

declare module '@basaltkit/core' {
  interface BasaltHooks {
    'file:uploaded': { file: FileRecord }
    'file:deleted': { tenantId: string; id: string }
    'file:scanned': { file: FileRecord }
  }
}

export const FILES = createToken<Files>('files')

export interface FilesPluginOptions {
  /** A `Disk` instance or the name of a disk configured in `@basaltkit/storage`. */
  disk: Disk | string
  store?: FileStore
  validate?: FileValidation
  maxTotalBytes?: number
  checkQuota?: FilesOptions['checkQuota']
}

export function filesPlugin(options: FilesPluginOptions) {
  return definePlugin({
    name: 'basalt:files',
    register({ container, hooks }) {
      // 'tenancy:active' is tenancyPlugin's marker: how a generic package
      // learns the app is multi-tenant without importing @basaltkit/tenancy.
      const metadata = ensureMetadata(container)
      container.singleton(FILES, () => {
        const disk = typeof options.disk === 'string' ? container.get(STORAGE).disk(options.disk) : options.disk
        return new Files({
          disk,
          hooks,
          ...(options.store ? { store: options.store } : {}),
          ...(options.validate ? { validate: options.validate } : {}),
          ...(options.maxTotalBytes !== undefined ? { maxTotalBytes: options.maxTotalBytes } : {}),
          ...(options.checkQuota ? { checkQuota: options.checkQuota } : {}),
        }, () => metadata.get('tenancy:active').length > 0)
      })
    },
  })
}

const files = () => (ctx().container as Container).get(FILES)

class FileAuthRequiredError extends BasaltError {
  readonly status = 401
  constructor() {
    super('AUTH_REQUIRED', 'Authentication required.')
  }
}

/** What a caller is trying to do with a file through {@link fileRoutes}. */
export type FileAction = 'read' | 'url' | 'delete'

/** The authenticated user a route runs as (`ctx().user`). */
export interface FileRouteUser {
  id: string
  [key: string]: unknown
}

export interface FileRoutesOptions {
  /**
   * Decides whether `user` may perform `action` on `record`. `GET /files` keeps
   * only the records this allows for `'read'`. Replaces the default policy.
   *
   * Default (neither this nor `shared`): **owner-only** — a user reaches only
   * the files whose `uploadedBy` is their own id. A file uploaded without
   * `uploadedBy` is reachable by nobody through these routes.
   */
  authorize?: (action: FileAction, record: FileRecord, user: FileRouteUser) => boolean | Promise<boolean>
  /**
   * Every authenticated user of the scope (the tenant, or the whole app without
   * tenancy) may read, sign and delete every file in it — a shared drive.
   * Ignored when `authorize` is given.
   */
  shared?: boolean
  /** Longest lifetime a client may request for a signed URL. Default `'1h'`. */
  maxUrlTtl?: DurationInput
}

const DEFAULT_URL_TTL = '15m'
const DEFAULT_MAX_URL_TTL = '1h'

const currentUser = (): FileRouteUser => {
  // `user` is set by @basaltkit/auth; read it without a hard dependency on it.
  const user = (ctx() as unknown as { user?: FileRouteUser }).user
  if (!user?.id) throw new FileAuthRequiredError()
  return user
}

const notFound = { error: { code: 'FILE_NOT_FOUND', message: 'File not found.' } }

/**
 * Read/manage routes for the current tenant's files: list, metadata, a signed
 * URL, and delete. Uploading is transport-specific (multipart) — call
 * `FILES.upload(buffer, input)` from your own upload handler, passing
 * `uploadedBy: ctx().user.id`.
 *
 * Secure by default: a user reaches only the files they uploaded. Pass
 * `authorize` for your own policy, or `shared: true` for a tenant-wide drive.
 * A file the caller may not reach answers 404, exactly like a missing one.
 */
export function fileRoutes(options: FileRoutesOptions = {}): BasaltRoute[] {
  const maxTtlMs = parseDuration(options.maxUrlTtl ?? DEFAULT_MAX_URL_TTL)
  // The lifetime used when the client names none, never longer than the cap.
  const defaultTtlMs = Math.min(parseDuration(DEFAULT_URL_TTL), maxTtlMs)
  const allowed = async (action: FileAction, record: FileRecord): Promise<boolean> => {
    const user = currentUser()
    if (options.authorize) return (await options.authorize(action, record, user)) === true
    if (options.shared === true) return true
    return record.uploadedBy !== undefined && record.uploadedBy === user.id
  }
  /** The record, or null when it is missing or the caller may not `action` it. */
  const reachable = async (id: string, action: FileAction): Promise<FileRecord | null> => {
    currentUser()
    const record = await files().get(id)
    return record && (await allowed(action, record)) ? record : null
  }
  const expiresIn = z
    .string()
    .refine((value) => {
      try {
        const ms = parseDuration(value)
        return ms > 0 && ms <= maxTtlMs
      } catch {
        return false
      }
    }, `expiresIn must be a positive duration of at most ${String(options.maxUrlTtl ?? DEFAULT_MAX_URL_TTL)}.`)

  return [
    route({
      method: 'GET',
      url: '/files',
      meta: { auth: true },
      async handler() {
        currentUser()
        const out: FileRecord[] = []
        for (const record of await files().list()) if (await allowed('read', record)) out.push(record)
        return out
      },
    }),
    route({
      method: 'GET',
      url: '/files/:id',
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      async handler({ params, reply }) {
        const record = await reachable(params.id, 'read')
        return record ?? reply.code(404).send(notFound)
      },
    }),
    route({
      method: 'POST',
      url: '/files/:id/url',
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      body: z.object({ expiresIn: expiresIn.optional() }).optional(),
      async handler({ params, body, reply }) {
        if (!(await reachable(params.id, 'url'))) return reply.code(404).send(notFound)
        return { url: await files().temporaryUrl(params.id, body?.expiresIn ?? defaultTtlMs) }
      },
    }),
    route({
      method: 'DELETE',
      url: '/files/:id',
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      async handler({ params, reply }) {
        if (!(await reachable(params.id, 'delete'))) return reply.code(404).send(notFound)
        await files().delete(params.id)
        return reply.code(204).send()
      },
    }),
  ]
}
