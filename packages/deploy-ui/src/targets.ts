import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, win32 } from 'node:path'

/**
 * Deploy targets (RFC 0009 §5): where the operator's SSH key and the `.env`
 * answers they type are sent. They live in the operator's own config
 * directory — never in the app repository, which anyone with commit access
 * could repoint — and every field has a closed grammar. They hold no secret.
 */

export interface Target {
  /** The UI's key for the target: shown everywhere, never put in argv. */
  name: string
  /** `[user@]host`, or a `Host` alias of the operator's `~/.ssh/config`. */
  ssh: string
  port?: number
  /** The checkout on the server, absolute. */
  dir: string
  /** The server's node, when a non-interactive shell lacks it on PATH. */
  node?: string
  /** `--config=<path>`, relative to the checkout. */
  config?: string
  /** run and rollback need the target's name typed to confirm. */
  protected?: boolean
}

export interface TargetsFile {
  version: 1
  /** Becomes `--actor`: self-declared attribution. */
  actor?: string
  targets: Target[]
}

export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/
const SSH_USER = /^[a-z_][a-z0-9_.-]{0,31}$/
const SSH_HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/
const SSH_IPV6 = /^[0-9A-Fa-f:]{2,39}$/
export const ABSOLUTE_PATH = /^\/[A-Za-z0-9._@+/-]{0,255}$/
export const RELATIVE_PATH = /^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,127}$/
/** The server's own `--actor` pattern (`@basaltkit/deploy` audit.ts). */
export const ACTOR = /^[A-Za-z0-9._@+-]{1,64}$/

const TARGET_FIELDS = new Set(['name', 'ssh', 'port', 'dir', 'node', 'config', 'protected'])
const FILE_FIELDS = new Set(['version', 'actor', 'targets'])
/** No file the UI reads is larger: a targets file is a few hundred bytes. */
const MAX_FILE_BYTES = 1024 * 1024
export const MAX_TARGETS = 100

const segments = (path: string) => path.split('/')
const hasDotDot = (path: string) => segments(path).includes('..')

export function validSsh(value: string): boolean {
  const at = value.lastIndexOf('@')
  const user = at === -1 ? undefined : value.slice(0, at)
  const host = at === -1 ? value : value.slice(at + 1)
  if (user !== undefined && !SSH_USER.test(user)) return false
  return SSH_HOST.test(host) || (host.includes(':') && SSH_IPV6.test(host))
}

export const validDir = (value: string) => ABSOLUTE_PATH.test(value) && !hasDotDot(value) && !value.includes('//')
export const validConfig = (value: string) => RELATIVE_PATH.test(value) && !hasDotDot(value) && !value.includes('//')

export type Checked<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** One target, every field against its grammar; unknown fields are refused, never ignored. */
export function checkTarget(input: unknown): Checked<Target> {
  if (!isObject(input)) return { ok: false, errors: { target: 'a target is a JSON object' } }
  const errors: Record<string, string> = {}
  for (const key of Object.keys(input)) {
    if (!TARGET_FIELDS.has(key)) errors[key] = `unknown field "${key}" — jump hosts, identity files and proxies belong in ~/.ssh/config, under a Host alias`
  }
  const { name, ssh, port, dir, node, config } = input
  const isProtected = input['protected']
  if (typeof name !== 'string' || !NAME.test(name)) errors['name'] = 'lowercase letters, digits and -, at most 40, starting with a letter or digit'
  if (typeof ssh !== 'string' || !validSsh(ssh)) errors['ssh'] = '[user@]host or a Host alias from ~/.ssh/config: no spaces, no leading -, no ssh:// URL'
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) errors['port'] = 'a whole number from 1 to 65535'
  if (typeof dir !== 'string' || !validDir(dir)) errors['dir'] = 'an absolute path of letters, digits and ._@+/- (no .., no //)'
  if (node !== undefined && (typeof node !== 'string' || !validDir(node))) errors['node'] = 'an absolute path to node on the server (no .., no //)'
  if (config !== undefined && (typeof config !== 'string' || !validConfig(config))) errors['config'] = 'a path relative to the checkout (no .., no leading /)'
  if (isProtected !== undefined && typeof isProtected !== 'boolean') errors['protected'] = 'true or false'
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      name: name as string, ssh: ssh as string, dir: dir as string,
      ...(port === undefined ? {} : { port: port as number }),
      ...(node === undefined ? {} : { node: node as string }),
      ...(config === undefined ? {} : { config: config as string }),
      ...(isProtected === true ? { protected: true } : {}),
    },
  }
}

/** The whole file: the version, the actor, every target, unique names. */
export function checkTargetsFile(input: unknown): Checked<TargetsFile> {
  if (!isObject(input)) return { ok: false, errors: { file: 'the targets file is not a JSON object' } }
  const errors: Record<string, string> = {}
  for (const key of Object.keys(input)) if (!FILE_FIELDS.has(key)) errors[key] = `unknown field "${key}"`
  if (input['version'] !== 1) errors['version'] = 'version must be 1'
  const actor = input['actor']
  if (actor !== undefined && (typeof actor !== 'string' || !ACTOR.test(actor))) errors['actor'] = 'letters, digits and ._@+-, at most 64'
  const list = input['targets']
  const targets: Target[] = []
  if (!Array.isArray(list) || list.length > MAX_TARGETS) errors['targets'] = `targets must be a list of at most ${MAX_TARGETS}`
  else {
    const names = new Set<string>()
    list.forEach((item, index) => {
      const checked = checkTarget(item)
      if (!checked.ok) {
        for (const [field, message] of Object.entries(checked.errors)) errors[`targets[${index}].${field}`] = message
        return
      }
      if (names.has(checked.value.name)) errors[`targets[${index}].name`] = `"${checked.value.name}" is used twice`
      names.add(checked.value.name)
      targets.push(checked.value)
    })
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, value: { version: 1, ...(actor === undefined ? {} : { actor: actor as string }), targets } }
}

/** `$XDG_CONFIG_HOME/basalt/deploy-targets.json` (absolute only, per the spec), `%APPDATA%\basalt\…` on Windows. */
export function defaultTargetsPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'win32') {
    const appData = env['APPDATA'] && win32.isAbsolute(env['APPDATA']) ? env['APPDATA'] : win32.join(home, 'AppData', 'Roaming')
    return win32.join(appData, 'basalt', 'deploy-targets.json')
  }
  const xdg = env['XDG_CONFIG_HOME']
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.config')
  return join(base, 'basalt', 'deploy-targets.json')
}

export class TargetsFileError extends Error {}

export interface LoadedTargets {
  file: TargetsFile
  /** False until the operator saves a first target. */
  exists: boolean
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0

/**
 * Reads the targets file without following a link (O_NOFOLLOW), and only if
 * it is a regular file nobody else can write. Missing → an empty file.
 */
export async function readTargets(path: string, platform: NodeJS.Platform = process.platform): Promise<LoadedTargets> {
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { file: { version: 1, targets: [] }, exists: false }
    if (code === 'ELOOP' || code === 'EMLINK') throw new TargetsFileError(`${path} is a symbolic link — refused, never followed`)
    throw new TargetsFileError(`cannot read ${path}: ${(error as Error).message}`)
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new TargetsFileError(`${path} is not a regular file — refused`)
    if (platform !== 'win32' && (stat.mode & 0o022) !== 0) {
      throw new TargetsFileError(`${path} is writable by other users (mode ${(stat.mode & 0o777).toString(8)}): anyone who can change it chooses where your secrets go — chmod 600 ${path}`)
    }
    if (stat.size > MAX_FILE_BYTES) throw new TargetsFileError(`${path} is larger than ${MAX_FILE_BYTES} bytes — refused`)
    const text = await handle.readFile({ encoding: 'utf8' })
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new TargetsFileError(`${path} is not JSON`)
    }
    const checked = checkTargetsFile(parsed)
    if (!checked.ok) {
      throw new TargetsFileError(`${path} is refused: ${Object.entries(checked.errors).map(([k, v]) => `${k}: ${v}`).join('; ')}`)
    }
    return { file: checked.value, exists: true }
  } finally {
    await handle.close()
  }
}

/** Written 0600 to a new temp file in the same directory (0700 when created), then renamed over the old one. */
export async function writeTargets(path: string, file: TargetsFile): Promise<void> {
  const checked = checkTargetsFile(file)
  if (!checked.ok) throw new TargetsFileError(`refused: ${Object.entries(checked.errors).map(([k, v]) => `${k}: ${v}`).join('; ')}`)
  const dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = join(dir, `.deploy-targets.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(checked.value, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}
