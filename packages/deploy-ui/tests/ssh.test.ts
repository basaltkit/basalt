import { describe, expect, it } from 'vitest'
import { classifySshFailure, DEPLOY_BIN, remoteCommand, shQuote, sshArgs, sshProgram, SSH_OPTIONS, type RemoteSpec } from '../src/ssh.js'
import type { Target } from '../src/targets.js'
import { posixWords } from './posix-words.mjs'

const staging: Target = { name: 'staging', ssh: 'deploy@203.0.113.10', dir: '/srv/myapp' }
const prod: Target = { name: 'production', ssh: 'myapp-prod', port: 2222, dir: '/srv/myapp', node: '/usr/local/bin/node', config: 'deploy.prod.ts', protected: true }
const RUN = '20261011T120000Z-0123456789ab'

describe('ssh argv', () => {
  it.each(['linux', 'darwin', 'win32'] as const)('%s: the program, the safety options, -- before the destination, one remote argument', (platform) => {
    const remote = remoteCommand(staging, { command: 'status' })
    expect({ program: sshProgram(platform), args: sshArgs(staging, remote) }).toMatchSnapshot()
    expect({ program: sshProgram(platform, '/opt/ssh'), args: sshArgs(prod, remoteCommand(prod, { command: 'run', answers: true, detach: true, unhold: true }, 'alice')) }).toMatchSnapshot()
  })

  it('Windows: always an absolute ssh.exe — the OpenSSH feature, else an absolute PATH entry; never ., a relative or an empty entry', () => {
    const builtIn = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
    const none = () => false
    expect(sshProgram('win32', undefined, {}, none)).toBe(builtIn)
    expect(sshProgram('win32', undefined, { SystemRoot: 'D:\\WINNT' }, none)).toBe('D:\\WINNT\\System32\\OpenSSH\\ssh.exe')
    const path = '.;;tools;"C:\\Program Files\\Git\\usr\\bin";\\\\share\\bin'
    const only = (wanted: string) => (candidate: string) => candidate === wanted
    expect(sshProgram('win32', undefined, { Path: path }, only('C:\\Program Files\\Git\\usr\\bin\\ssh.exe'))).toBe('C:\\Program Files\\Git\\usr\\bin\\ssh.exe')
    expect(sshProgram('win32', undefined, { PATH: path }, only(builtIn))).toBe(builtIn)
    // A planted ssh.exe in the working directory or a relative entry is never a candidate.
    const asked: string[] = []
    sshProgram('win32', undefined, { Path: path }, (candidate) => { asked.push(candidate); return false })
    expect(asked).toEqual([builtIn, 'C:\\Program Files\\Git\\usr\\bin\\ssh.exe'])
    expect(sshProgram('win32', 'C:\\tools\\ssh.exe', {}, none)).toBe('C:\\tools\\ssh.exe')
    expect(sshProgram('linux', undefined, { PATH: '.' }, none)).toBe('ssh')
  })

  it('never forwards, never prompts, never runs a local command, never reads another config or key', () => {
    const args = sshArgs(prod, 'x')
    for (const flag of ['-A', '-F', '-i', '-J', '-X', '-Y', '-L', '-R', '-D', '-W', '-N', '-t']) expect(args, flag).not.toContain(flag)
    for (const option of args.filter((_, i) => args[i - 1] === '-o')) expect(option).not.toMatch(/ProxyCommand|ProxyJump|StrictHostKeyChecking=(no|accept-new)|IdentityFile|^LocalCommand=|SendEnv|SetEnv|PermitLocalCommand=yes/)
    expect(SSH_OPTIONS).toEqual(expect.arrayContaining(['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes', 'PermitLocalCommand=no', 'RequestTTY=no']))
    expect(args.indexOf('--')).toBe(args.length - 3)
    expect(args.at(-2)).toBe('myapp-prod')
    expect(args.slice(args.indexOf('-p'), args.indexOf('-p') + 2)).toEqual(['-p', '2222'])
    expect(() => sshArgs({ ...staging, ssh: '-oProxyCommand=x' }, 'x')).toThrow(/destination/)
    expect(() => sshArgs({ ...staging, port: 0 }, 'x')).toThrow(/port/)
  })
})

describe('the remote command', () => {
  const words = (target: Target, spec: RemoteSpec, actor?: string) => {
    const split = posixWords(remoteCommand(target, spec, actor))
    expect(split.unquotedSpecials.join('')).toBe('&&')
    return split.words
  }

  it('is cd + exec of the app\'s pinned deploy, every piece quoted, flags from a closed set', () => {
    expect(words(staging, { command: 'status' })).toEqual(['cd', '/srv/myapp', '&&', 'exec', 'node', DEPLOY_BIN, 'status', '--json=1'])
    expect(words(prod, { command: 'run', answers: true, detach: true, unhold: true }, 'alice@example.com')).toEqual(['cd', '/srv/myapp', '&&', 'exec', '/usr/local/bin/node', DEPLOY_BIN, 'run', '--json=1', '--answers=stdin', '--detach', '--unhold', '--via=ui', '--actor=alice@example.com', '--config=deploy.prod.ts'])
    expect(words(staging, { command: 'rollback', detach: true, to: 'abcdef1' })).toEqual(['cd', '/srv/myapp', '&&', 'exec', 'node', DEPLOY_BIN, 'rollback', '--json=1', '--detach', '--to=abcdef1', '--via=ui'])
    expect(words(staging, { command: 'attach', runId: RUN, follow: true, fromSeq: 42 })).toEqual(['cd', '/srv/myapp', '&&', 'exec', 'node', DEPLOY_BIN, 'attach', RUN, '--json=1', '--follow', '--from-seq=42'])
    expect(words(staging, { command: 'cancel', runId: RUN })).toEqual(['cd', '/srv/myapp', '&&', 'exec', 'node', DEPLOY_BIN, 'cancel', RUN, '--json=1'])
    expect(words(staging, { command: 'cancel', runId: RUN, firstOnly: true })).toEqual(['cd', '/srv/myapp', '&&', 'exec', 'node', DEPLOY_BIN, 'cancel', RUN, '--json=1', '--first-only'])
    expect(words(staging, { command: 'env', answers: true })).toEqual(['cd', '/srv/myapp', '&&', 'exec', 'node', DEPLOY_BIN, 'env', '--json=1', '--answers=stdin', '--via=ui'])
    expect(remoteCommand(staging, { command: 'plan' })).not.toMatch(/npx|pnpm/)
  })

  it('quoting round-trips adversarial words through a POSIX shell splitter, whatever the grammar would say', () => {
    for (const word of ["it's", "'; rm -rf / #", '$(id)', '`id`', '"x"', 'a\\b', 'a b\tc', '&&', '\n', "''", "'\\''", '${HOME}', '*', '~']) {
      const split = posixWords(`${shQuote(word)} ${shQuote('next')}`)
      expect(split.words, JSON.stringify(word)).toEqual([word, 'next'])
      expect(split.unquotedSpecials).toEqual([])
    }
  })

  it('refuses what the grammar refuses, a second time', () => {
    const refused: Array<[Target, RemoteSpec, string?]> = [
      [{ ...staging, dir: "/srv/it's" }, { command: 'status' }],
      [{ ...staging, node: 'node; id' }, { command: 'status' }],
      [{ ...staging, config: '../x' }, { command: 'status' }],
      [staging, { command: 'attach', runId: '../../etc/passwd' }],
      [staging, { command: 'cancel' }],
      [staging, { command: 'rollback', to: 'HEAD~1' }],
      [staging, { command: 'run', to: 'abcdef1' }],
      [staging, { command: 'status', answers: true }],
      [staging, { command: 'env', detach: true }],
      [staging, { command: 'rollback', unhold: true }],
      [staging, { command: 'status', firstOnly: true }],
      [staging, { command: 'attach', runId: RUN, fromSeq: -1 }],
      [staging, { command: 'run' }, 'alice smith'],
      [staging, { command: 'install' as RemoteSpec['command'] }],
      [staging, { command: 'bootstrap' as RemoteSpec['command'] }],
    ]
    for (const [target, spec, actor] of refused) expect(() => remoteCommand(target, spec, actor), JSON.stringify([target, spec, actor])).toThrow(/refused/)
  })
})

describe('ssh failures, explained', () => {
  const d = 'deploy@203.0.113.10'
  it.each([
    ['deploy@203.0.113.10: Permission denied (publickey).', 255, 'auth', /ssh-add/],
    ['Load key "/home/alice/.ssh/id_ed25519": incorrect passphrase supplied to decrypt private key', 255, 'passphrase', /ssh-add/],
    ['No ED25519 host key is known for 203.0.113.10 and you have requested strict checking.\nHost key verification failed.', 255, 'host-key', /ssh deploy@203\.0\.113\.10/],
    ['@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @', 255, 'host-key', /fingerprint/],
    ['ssh: connect to host 203.0.113.10 port 22: Operation timed out', 255, 'timeout', /reachable/],
    ['ssh: Could not resolve hostname myapp-prod: nodename nor servname provided, or not known', 255, 'resolve', /alias/],
    ['ssh: connect to host 203.0.113.10 port 22: Connection refused', 255, 'refused', /sshd/],
    ['ssh: connect to host 203.0.113.10 port 22: No route to host', 255, 'network', undefined],
    ["Error: Cannot find module '/srv/myapp/node_modules/@basaltkit/deploy/dist/bin.js'", 1, 'no-deploy', /pnpm install/],
    ['sh: 1: cd: can\'t cd to /srv/nope', 2, 'no-dir', /checkout/],
    ['bash: line 1: cd: /srv/nope: No such file or directory', 1, 'no-dir', /checkout/],
    ['bash: line 1: exec: node: not found', 127, 'no-node', /absolute path/],
    ['something else', 255, 'ssh', undefined],
  ] as const)('%s', (stderr, code, expected, hint) => {
    const failure = classifySshFailure(code, stderr, d)
    expect(failure?.code).toBe(expected)
    if (hint) expect(failure?.hint).toMatch(hint)
  })

  it('is silent when nothing matches', () => {
    expect(classifySshFailure(1, 'warning: something', d)).toBeUndefined()
  })

  it('stays linear on hostile stderr (no polynomial backtracking)', () => {
    const hostile = 'Cannot find module'.repeat(50_000) + '\n' + ' cd'.repeat(50_000) + '\n' + 'exec: node'.repeat(50_000)
    const started = performance.now()
    expect(classifySshFailure(1, hostile, d)).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(500)
  })
})
