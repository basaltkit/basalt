import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkTarget, checkTargetsFile, defaultTargetsPath, readTargets, TargetsFileError, validSsh, writeTargets } from '../src/targets.js'

let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-ui-targets-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

const base = { name: 'staging', ssh: 'deploy@203.0.113.10', dir: '/srv/myapp' }
const errorsOf = (input: unknown) => {
  const checked = checkTarget(input)
  return checked.ok ? [] : Object.keys(checked.errors).sort()
}

describe('the target grammar', () => {
  it('accepts user@host, an alias, IPv4 and IPv6 literals, a port, node, config, protected', () => {
    for (const ssh of ['deploy@203.0.113.10', 'myapp-prod', 'deploy@example.com', 'deploy@2001:db8::1', '_svc.deploy@host-1.example.com']) expect(validSsh(ssh), ssh).toBe(true)
    expect(checkTarget({ ...base, port: 2222, node: '/usr/local/bin/node', config: 'deploy/prod.config.ts', protected: true })).toEqual({
      ok: true, value: { ...base, port: 2222, node: '/usr/local/bin/node', config: 'deploy/prod.config.ts', protected: true },
    })
    expect(checkTarget({ ...base, protected: false })).toEqual({ ok: true, value: base })
  })

  it('refuses option injection, whitespace, controls, %, URLs and traversal', () => {
    const badSsh = ['-oProxyCommand=sh', 'deploy@-oProxyCommand=x', '-p', 'de ploy@host', 'host\u0000', 'host\r', 'host\n', 'ssh://deploy@host', 'deploy@host%22', 'Deploy@host', 'deploy@@host', '', 'deploy@', '@host', 'a'.repeat(300), 'deploy@host;id', 'deploy@$(id)', 'deploy@`id`']
    for (const ssh of badSsh) expect(errorsOf({ ...base, ssh }), JSON.stringify(ssh)).toEqual(['ssh'])
    for (const d of ['srv/myapp', '/srv/../etc', '/srv//x', "/srv/my app", "/srv/it's", '/srv/$HOME', '/srv/a;b', '/srv/\u0000', '']) expect(errorsOf({ ...base, dir: d }), d).toEqual(['dir'])
    for (const node of ['node', '/usr/bin/../bin/node', '/usr/bin/node --inspect']) expect(errorsOf({ ...base, node }), node).toEqual(['node'])
    for (const config of ['/etc/x.ts', '../x.ts', 'a/../../x.ts', 'a b.ts', 'a//b.ts']) expect(errorsOf({ ...base, config }), config).toEqual(['config'])
    for (const port of [0, 65536, 22.5, '22', -1]) expect(errorsOf({ ...base, port }), String(port)).toEqual(['port'])
    for (const name of ['Staging', '-x', 'a'.repeat(41), 'a b', '', 'x/../y']) expect(errorsOf({ ...base, name }), name).toEqual(['name'])
    expect(errorsOf({ ...base, protected: 'yes' })).toEqual(['protected'])
    expect(errorsOf({ ...base, proxyCommand: 'nc %h %p', identityFile: '~/.ssh/id' })).toEqual(['identityFile', 'proxyCommand'])
    expect(checkTarget('x')).toMatchObject({ ok: false })
    expect(checkTarget([base])).toMatchObject({ ok: false })
  })

  it('the file: version 1, an actor of the server\'s grammar, unique names, nothing unknown', () => {
    expect(checkTargetsFile({ version: 1, actor: 'alice@example.com', targets: [base] })).toMatchObject({ ok: true })
    const bad = checkTargetsFile({ version: 2, actor: 'alice smith', targets: [base, base, { ...base, ssh: '-x' }], extra: 1 })
    expect(bad.ok ? [] : Object.keys(bad.errors).sort()).toEqual(['actor', 'extra', 'targets[1].name', 'targets[2].ssh', 'version'])
    expect(checkTargetsFile({ version: 1, targets: 'x' })).toMatchObject({ ok: false, errors: { targets: expect.any(String) } })
    expect(checkTargetsFile(null)).toMatchObject({ ok: false })
  })
})

describe('the targets file', () => {
  it('lives in the operator\'s config directory, per platform', () => {
    expect(defaultTargetsPath('linux', {}, '/home/alice')).toBe('/home/alice/.config/basalt/deploy-targets.json')
    expect(defaultTargetsPath('darwin', { XDG_CONFIG_HOME: '/home/alice/cfg' }, '/home/alice')).toBe('/home/alice/cfg/basalt/deploy-targets.json')
    // A relative XDG_CONFIG_HOME is ignored, as the spec says.
    expect(defaultTargetsPath('linux', { XDG_CONFIG_HOME: 'cfg' }, '/home/alice')).toBe('/home/alice/.config/basalt/deploy-targets.json')
    expect(defaultTargetsPath('win32', { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' }, 'C:\\Users\\alice')).toBe('C:\\Users\\alice\\AppData\\Roaming\\basalt\\deploy-targets.json')
    expect(defaultTargetsPath('win32', {}, 'C:\\Users\\alice')).toBe('C:\\Users\\alice\\AppData\\Roaming\\basalt\\deploy-targets.json')
  })

  it('is created 0600 by rename (directory 0700), and read back', async () => {
    const path = join(dir, 'new', 'basalt', 'deploy-targets.json')
    expect(await readTargets(path)).toEqual({ file: { version: 1, targets: [] }, exists: false })
    await writeTargets(path, { version: 1, actor: 'alice', targets: [base] })
    expect(await readTargets(path)).toEqual({ file: { version: 1, actor: 'alice', targets: [base] }, exists: true })
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(join(dir, 'new', 'basalt'))).mode & 0o777).toBe(0o700)
    }
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, actor: 'alice', targets: [base] })
    await expect(writeTargets(path, { version: 1, targets: [{ ...base, ssh: '-x' }] })).rejects.toThrow(TargetsFileError)
  })

  it.skipIf(process.platform === 'win32')('refuses a link, a non-file, a file others can write, invalid content', async () => {
    const real = join(dir, 'real.json')
    await writeFile(real, JSON.stringify({ version: 1, targets: [] }), { mode: 0o600 })
    const link = join(dir, 'link.json')
    await symlink(real, link)
    await expect(readTargets(link)).rejects.toThrow(/symbolic link/)
    await expect(readTargets(dir)).rejects.toThrow(/not a regular file|cannot read/)
    const open = join(dir, 'open.json')
    await writeFile(open, JSON.stringify({ version: 1, targets: [] }))
    await chmod(open, 0o664)
    await expect(readTargets(open)).rejects.toThrow(/writable by other users/)
    const garbage = join(dir, 'garbage.json')
    await writeFile(garbage, 'nope', { mode: 0o600 })
    await expect(readTargets(garbage)).rejects.toThrow(/not JSON/)
    const unknown = join(dir, 'unknown.json')
    await writeFile(unknown, JSON.stringify({ version: 1, targets: [{ ...base, proxyJump: 'bastion' }] }), { mode: 0o600 })
    await expect(readTargets(unknown)).rejects.toThrow(/proxyJump/)
    expect(await readTargets(open, 'win32')).toMatchObject({ exists: true })
  })
})
