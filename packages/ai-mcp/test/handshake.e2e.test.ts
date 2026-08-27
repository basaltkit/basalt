import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { memoryReader } from '@basaltkit/ai/analysis'
import { describe, expect, it } from 'vitest'
import { createAiMcpServer } from '../src/index.js'
import { PROJECT_FILES } from './fixture.js'

const flush = () => new Promise((r) => setImmediate(r))

function collector() {
  const lines: any[] = []
  return {
    lines,
    output: {
      write(chunk: string) {
        for (const line of chunk.split('\n')) if (line.trim()) lines.push(JSON.parse(line))
        return true
      },
    },
  }
}

describe('stdio handshake (piped streams — the transport the bin drives)', () => {
  it('initialize → tools/list → resources/list → basalt_analyze → basalt_doctor', async () => {
    const input = new PassThrough()
    const { lines, output } = collector()
    const handle = createAiMcpServer({
      cwd: '/proj',
      createReader: () => memoryReader(PROJECT_FILES),
      input,
      output,
    })
    const send = (msg: unknown) => input.write(`${JSON.stringify(msg)}\n`)

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' }) // no reply
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    send({ jsonrpc: '2.0', id: 3, method: 'resources/list' })
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'basalt_analyze', arguments: {} } })
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'basalt_doctor', arguments: {} } })
    send({ jsonrpc: '2.0', id: 6, method: 'prompts/list' })
    await flush()
    await flush()
    await flush()

    // six responses; the notification produced none
    expect(lines).toHaveLength(6)

    const init = lines.find((l) => l.id === 1)!.result
    expect(init.serverInfo).toEqual({ name: 'basalt-ai-mcp', version: '0.1.0' })
    // capabilities advertise tools, resources AND prompts
    expect(init.capabilities.tools).toBeDefined()
    expect(init.capabilities.resources).toBeDefined()
    expect(init.capabilities.prompts).toBeDefined()

    const tools = lines.find((l) => l.id === 2)!.result.tools.map((t: { name: string }) => t.name).sort()
    expect(tools).toEqual(['basalt_analyze', 'basalt_doctor', 'basalt_make', 'basalt_plan', 'basalt_review'])

    const resources = lines.find((l) => l.id === 3)!.result.resources.map((r: { uri: string }) => r.uri)
    expect(resources).toContain('basalt://project/context')
    expect(resources).toContain('basalt://knowledge/architecture')

    // tool results carry structuredContent
    const analyze = lines.find((l) => l.id === 4)!.result
    expect(analyze.structuredContent.models).toEqual(['Tenant'])
    const doctor = lines.find((l) => l.id === 5)!.result
    expect(doctor.structuredContent.hasErrors).toBe(true)
    expect(doctor.structuredContent.fixes.length).toBeGreaterThan(0)

    const prompts = lines.find((l) => l.id === 6)!.result.prompts.map((p: { name: string }) => p.name)
    expect(prompts).toContain('plan-feature')

    handle.close()
  })
})

// The real bin, spawned as a child process — proves it boots a stdio server and
// completes an initialize handshake. Skipped if the package hasn't been built.
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url))

describe.skipIf(!existsSync(BIN))('basalt-ai-mcp bin', () => {
  it('boots over stdio and completes an initialize handshake', async () => {
    const child = spawn(process.execPath, [BIN, `--cwd=${process.cwd()}`], { stdio: ['pipe', 'pipe', 'inherit'] })
    try {
      // Register the line reader BEFORE sending, so the response can't be missed.
      const linePromise = new Promise<string>((resolve, reject) => {
        let buf = ''
        const timer = setTimeout(() => reject(new Error('bin did not respond in time')), 10_000)
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          buf += chunk
          const nl = buf.indexOf('\n')
          if (nl >= 0) {
            clearTimeout(timer)
            resolve(buf.slice(0, nl))
          }
        })
        child.on('error', reject)
      })
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`,
      )
      const response = JSON.parse(await linePromise)
      expect(response.result.serverInfo.name).toBe('basalt-ai-mcp')
    } finally {
      child.stdin.end()
      child.kill()
    }
  })
})
