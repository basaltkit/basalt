import { createToken, ctx, definePlugin, type Container } from '@machize/core'
import { STORAGE, type Disk } from '@machize/storage'
import { route, type MachizeRoute } from '@machize/fastify'
import { z } from 'zod'
import { Files, type FileValidation, type FilesOptions } from './files.js'
import type { FileRecord, FileStore } from './store.js'

declare module '@machize/core' {
  interface MachizeHooks {
    'file:uploaded': { file: FileRecord }
    'file:deleted': { tenantId: string; id: string }
    'file:scanned': { file: FileRecord }
  }
}

export const FILES = createToken<Files>('files')

export interface FilesPluginOptions {
  /** A `Disk` instance or the name of a disk configured in `@machize/storage`. */
  disk: Disk | string
  store?: FileStore
  validate?: FileValidation
  maxTotalBytes?: number
  checkQuota?: FilesOptions['checkQuota']
}

export function filesPlugin(options: FilesPluginOptions) {
  return definePlugin({
    name: 'machize:files',
    register({ container, hooks }) {
      container.singleton(FILES, () => {
        const disk = typeof options.disk === 'string' ? container.get(STORAGE).disk(options.disk) : options.disk
        return new Files({
          disk,
          hooks,
          ...(options.store ? { store: options.store } : {}),
          ...(options.validate ? { validate: options.validate } : {}),
          ...(options.maxTotalBytes !== undefined ? { maxTotalBytes: options.maxTotalBytes } : {}),
          ...(options.checkQuota ? { checkQuota: options.checkQuota } : {}),
        })
      })
    },
  })
}

const files = () => (ctx().container as Container).get(FILES)

/**
 * Read/manage routes for the current tenant's files: list, metadata, a signed
 * URL, and delete. Uploading is transport-specific (multipart) — call
 * `FILES.upload(buffer, input)` from your own upload handler.
 */
export function fileRoutes(): MachizeRoute[] {
  return [
    route({
      method: 'GET',
      url: '/files',
      meta: { auth: true },
      async handler() {
        return files().list()
      },
    }),
    route({
      method: 'GET',
      url: '/files/:id',
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      async handler({ params, reply }) {
        const record = await files().get(params.id)
        return record ?? reply.code(404).send({ error: { code: 'FILE_NOT_FOUND', message: 'File not found.' } })
      },
    }),
    route({
      method: 'POST',
      url: '/files/:id/url',
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      body: z.object({ expiresIn: z.string().optional() }).optional(),
      async handler({ params, body }) {
        return { url: await files().temporaryUrl(params.id, body?.expiresIn ?? '15m') }
      },
    }),
    route({
      method: 'DELETE',
      url: '/files/:id',
      meta: { auth: true },
      params: z.object({ id: z.string() }),
      async handler({ params, reply }) {
        await files().delete(params.id)
        return reply.code(204).send()
      },
    }),
  ]
}
