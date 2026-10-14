import type { SpawnOptions } from 'node:child_process'
import { win32 } from 'node:path'
import type { Spawn } from './remote.js'
import { windowsSystemRoot } from './ssh.js'

/**
 * The platform's browser opener, as argv (RFC 0009 §4.6): never a shell —
 * `cmd /c start` would need one and mangles `&` and `#`. On Windows an
 * absolute `rundll32.exe`: a bare name is looked up in the working directory
 * first.
 */
export function openerCommand(platform: NodeJS.Platform, url: string, env: NodeJS.ProcessEnv = {}): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] }
  if (platform === 'win32') return { command: win32.join(windowsSystemRoot(env), 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler', url] }
  return { command: 'xdg-open', args: [url] }
}

/** Starts the opener, detached and silent, in `cwd` (the home directory, never the app's); resolves false when it could not start or failed. */
export function openBrowser(spawn: Spawn, platform: NodeJS.Platform, url: string, cwd?: string, env: NodeJS.ProcessEnv = {}): Promise<boolean> {
  const { command, args } = openerCommand(platform, url, env)
  return new Promise((resolve) => {
    try {
      const options: SpawnOptions = { shell: false, stdio: 'ignore', detached: platform !== 'win32', windowsHide: true, ...(cwd ? { cwd } : {}) }
      const child = spawn(command, args, options)
      child.on('error', () => resolve(false))
      child.on('exit', (code) => resolve(code === 0))
      child.unref()
    } catch {
      resolve(false)
    }
  })
}
