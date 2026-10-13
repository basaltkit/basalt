import type { SpawnOptions } from 'node:child_process'
import type { Spawn } from './remote.js'

/**
 * The platform's browser opener, as argv (RFC 0009 §4.6): never a shell —
 * `cmd /c start` would need one and mangles `&` and `#`.
 */
export function openerCommand(platform: NodeJS.Platform, url: string): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] }
  return { command: 'xdg-open', args: [url] }
}

/** Starts the opener, detached and silent; resolves false when it could not start or failed. */
export function openBrowser(spawn: Spawn, platform: NodeJS.Platform, url: string): Promise<boolean> {
  const { command, args } = openerCommand(platform, url)
  return new Promise((resolve) => {
    try {
      const options: SpawnOptions = { shell: false, stdio: 'ignore', detached: platform !== 'win32', windowsHide: true }
      const child = spawn(command, args, options)
      child.on('error', () => resolve(false))
      child.on('exit', (code) => resolve(code === 0))
      child.unref()
    } catch {
      resolve(false)
    }
  })
}
