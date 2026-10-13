import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { nodeHost, type Output } from '../src/host.js'

const quiet: Output = { step() {}, info() {}, ok() {}, warn() {}, error() {} }
let dir: string
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'basalt-deploy-proto-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('the real host, for the machine protocol', () => {
  it('creates a run log 0600 and exclusively; never through a planted link; appends', async () => {
    const host = nodeHost(quiet)
    const path = join(dir, 'run.ndjson')
    const log = await host.createLog!(path, 0o600)
    log.append('one\n')
    log.append('two é\n')
    log.close()
    expect(await readFile(path, 'utf8')).toBe('one\ntwo é\n')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(host.createLog!(path, 0o600)).rejects.toThrow(/EEXIST/)
    await symlink(join(dir, 'target'), join(dir, 'planted.ndjson'))
    await expect(host.createLog!(join(dir, 'planted.ndjson'), 0o600)).rejects.toThrow()
    await expect(readFile(join(dir, 'target'))).rejects.toThrow(/ENOENT/)
  })

  it('reads a range of a regular file with its owner and mode; refuses a link and a directory', async () => {
    const host = nodeHost(quiet)
    const path = join(dir, 'range.ndjson')
    await writeFile(path, 'abcdefgh', { mode: 0o600 })
    await chmod(path, 0o600)
    const range = await host.readFileRange!(path, 2, 3)
    expect(Buffer.from(range.data).toString()).toBe('cde')
    expect(range).toMatchObject({ size: 8, mode: 0o600, uid: process.getuid?.() })
    expect((await host.readFileRange!(path, 6, 100)).data.length).toBe(2)
    expect((await host.readFileRange!(path, 50, 100)).data.length).toBe(0)
    await symlink(path, join(dir, 'link.ndjson'))
    await expect(host.readFileRange!(join(dir, 'link.ndjson'), 0, 10)).rejects.toThrow(/symbolic link/)
    await mkdir(join(dir, 'adir'))
    await expect(host.readFileRange!(join(dir, 'adir'), 0, 10)).rejects.toThrow(/not a regular file/)
  })

  it('a streamed child in JSON mode is piped: its output reaches the sink, its stdin is closed', async () => {
    const host = nodeHost(quiet)
    const seen: Array<[string, string]> = []
    const script = 'let n=0;process.stdin.on("data",()=>n++);process.stdin.on("end",()=>{process.stdout.write("stdin closed "+n+"\\né");process.stderr.write("warned\\n")})'
    const result = await host.exec(process.execPath, ['-e', script], { stream: true, onOutput: (text, stream) => seen.push([stream, text]) })
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(seen.filter(([s]) => s === 'stdout').map(([, t]) => t).join('')).toBe('stdin closed 0\né')
    expect(seen.filter(([s]) => s === 'stderr').map(([, t]) => t).join('')).toBe('warned\n')
  })

  it('a detached child gets its own session and process group, its answers on stdin, its log as stdout; it outlives the call', async () => {
    const host = nodeHost(quiet)
    const path = join(dir, 'detached.ndjson')
    const log = await host.createLog!(path, 0o600)
    const script = 'let s="";process.stdin.on("data",(c)=>s+=c);process.stdin.on("end",()=>setTimeout(()=>process.stdout.write("got "+s.trim()+" from "+process.pid+"\\n"),200))'
    const { pid } = await host.spawnDetached!(process.execPath, ['-e', script], { cwd: dir, env: { PATH: process.env['PATH'] }, stdin: 'answer-line\n', stdout: log })
    log.close()
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim())
    expect(pgid).toBe(pid)
    expect(pgid).not.toBe(Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)]).toString().trim()))
    await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toBe(`got answer-line from ${pid}\n`), { timeout: 5000 })
    await expect(host.spawnDetached!(join(dir, 'no-such-binary'), [], { cwd: dir, env: {}, stdin: '', stdout: { fd: 1, append() {}, close() {} } })).rejects.toThrow(/ENOENT/)
    await expect(host.spawnDetached!(process.execPath, [], { cwd: dir, env: {}, stdin: '', stdout: { append() {}, close() {} } })).rejects.toThrow(/no descriptor/)
  })

  it('signals one process; reads a process\'s argv only where /proc exists', async () => {
    const host = nodeHost(quiet)
    const child = execFileSync(process.execPath, ['-e', 'const c=require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},10000)","--","--marker"],{detached:true,stdio:"ignore"});c.unref();console.log(c.pid)']).toString().trim()
    const pid = Number(child)
    expect(host.processAlive(pid)).toBe(true)
    const argv = await host.processCmdline!(pid)
    if (process.platform === 'linux') expect(argv).toContain('--marker')
    else expect(argv).toBeUndefined()
    host.kill!(pid, 'SIGTERM')
    await vi.waitFor(() => expect(host.processAlive(pid)).toBe(false), { timeout: 5000 })
    expect(await host.processCmdline!(2 ** 22 + 7)).toBeUndefined()
  })
})
