import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createClient, endpoint } from '../src/index.js'

/**
 * F-16 · Request bodies the browser already knows how to send, and cancellation.
 *
 * The client always serialised to JSON: it declared `content-type:
 * application/json` and called `JSON.stringify` on whatever it was given. That
 * is right for the common case and wrong for the one the platform already
 * solves — a `FormData` upload, where the browser has to set the boundary
 * itself and `JSON.stringify(formData)` yields `"{}"`.
 *
 * It also had nowhere to put an `AbortSignal`, so a client could not cancel.
 * That costs nothing until there is a search-as-you-type field, and then every
 * keystroke is a request that no one can call off.
 */
const espiao = () => {
  const chamadas: { url: string; init: RequestInit }[] = []
  const fetch = async (url: string, init: RequestInit = {}) => {
    chamadas.push({ url, init })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { chamadas, fetch: fetch as unknown as typeof globalThis.fetch }
}

const api = (fetch: typeof globalThis.fetch) =>
  createClient(
    {
      upload: endpoint({ method: 'POST', path: '/files', result: z.object({ ok: z.boolean() }) }),
      list: endpoint({ method: 'GET', path: '/files', result: z.object({ ok: z.boolean() }) }),
    },
    { baseUrl: '', fetch },
  )

describe('F-16 · FormData is sent as-is', () => {
  it('does not JSON-stringify a FormData body', async () => {
    const { chamadas, fetch } = espiao()
    const forma = new FormData()
    forma.append('file', new Blob(['x']), 'a.txt')

    await api(fetch).upload({ body: forma })

    // `JSON.stringify(new FormData())` is `"{}"` — the upload would arrive empty.
    expect(chamadas[0]!.init.body).toBeInstanceOf(FormData)
  })

  it('leaves content-type unset so the browser writes the boundary', async () => {
    const { chamadas, fetch } = espiao()
    const forma = new FormData()
    forma.append('file', new Blob(['x']), 'a.txt')

    await api(fetch).upload({ body: forma })

    // Declaring `multipart/form-data` by hand omits the boundary, and the
    // server then cannot split the parts. Only `fetch` knows it.
    const headers = chamadas[0]!.init.headers as Record<string, string>
    expect(headers['content-type']).toBeUndefined()
  })

  it('still sends JSON for plain objects', async () => {
    const { chamadas, fetch } = espiao()
    await api(fetch).upload({ body: { nome: 'a' } })

    const headers = chamadas[0]!.init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/json')
    expect(chamadas[0]!.init.body).toBe('{"nome":"a"}')
  })

  it('passes a Blob through too', async () => {
    const { chamadas, fetch } = espiao()
    const blob = new Blob(['content'], { type: 'application/pdf' })
    await api(fetch).upload({ body: blob })

    expect(chamadas[0]!.init.body).toBeInstanceOf(Blob)
  })
})

describe('F-16 · AbortSignal reaches fetch', () => {
  it('forwards the signal', async () => {
    const { chamadas, fetch } = espiao()
    const controlador = new AbortController()

    await api(fetch).list({ signal: controlador.signal })

    expect(chamadas[0]!.init.signal).toBe(controlador.signal)
  })

  it('rejects when the caller aborts', async () => {
    /**
     * O `fetch` real rejeita when o sinal dispara, e um sinal JÁ abortado
     * rejeita de imediato. A first versão deste teste abortava depois de
     * chamar e ficava pendurada trinta segundos: o `request` faz trabalho
     * assíncrono antes do `fetch`, e o `abort` chegou primeiro — ninguém
     * estava a ouvir. Abortar antes reproduz o mesmo sem a corrida.
     */
    const controlador = new AbortController()
    controlador.abort()

    const fetch = ((_url: string, init: RequestInit = {}) => {
      if (init.signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof globalThis.fetch

    await expect(api(fetch).list({ signal: controlador.signal })).rejects.toThrow('Aborted')
  })

  it('sends no signal when the caller gives none', async () => {
    const { chamadas, fetch } = espiao()
    await api(fetch).list({})
    expect(chamadas[0]!.init.signal).toBeUndefined()
  })
})

describe('F-16 · per-call headers', () => {
  it('merges with the client headers, and the call wins', async () => {
    const { chamadas, fetch } = espiao()
    const client = createClient(
      { list: endpoint({ method: 'GET', path: '/files', result: z.object({ ok: z.boolean() }) }) },
      { baseUrl: '', fetch, headers: { 'x-app': 'demo', 'x-shared': 'do-client' } },
    )

    await client.list({ headers: { 'x-shared': 'da-chamada', 'x-pedido': '1' } })

    const headers = chamadas[0]!.init.headers as Record<string, string>
    expect(headers['x-app']).toBe('demo')
    expect(headers['x-pedido']).toBe('1')
    // The narrower scope wins — the same rule as everywhere else in the client.
    expect(headers['x-shared']).toBe('da-chamada')
  })
})
