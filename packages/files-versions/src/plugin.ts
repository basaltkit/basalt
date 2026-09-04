import { createToken, definePlugin } from '@basaltkit/core'
import { FILES } from '@basaltkit/files'
import { FileVersions } from './versions.js'
import type { FileVersionStore } from './store.js'

export const FILE_VERSIONS = createToken<FileVersions>('files.versions')

export interface FileVersionsPluginOptions {
  /**
   * Where the history lives. Defaults to memory, which is fine for a test and
   * wrong for anything else: a restart takes the revision history with it and
   * leaves the files behind, so every past draft is still on the disk with
   * nothing left to say which document it belonged to.
   */
  store?: FileVersionStore
}

/**
 * Registers `FILE_VERSIONS`, layered on the `FILES` service.
 *
 * Depends on `basalt:files` by name rather than constructing its own `Files`:
 * two services with different quota settings writing to the same disk is the
 * kind of divergence nobody notices until an upload is refused in one code path
 * and accepted in another.
 */
export function fileVersionsPlugin(options: FileVersionsPluginOptions = {}) {
  return definePlugin({
    name: 'basalt:files-versions',
    dependsOn: ['basalt:files'],
    register({ container, hooks }) {
      container.singleton(FILE_VERSIONS, () => {
        return new FileVersions({
          files: container.get(FILES),
          hooks,
          ...(options.store ? { store: options.store } : {}),
        })
      })
    },
  })
}
