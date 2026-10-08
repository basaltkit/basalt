// Cloudflare Email Routing -> Basalt relay (wire format v1, RFC 0003).
// Secrets: BASALT_INBOUND_URL and BASALT_INBOUND_SECRET (wrangler secret put).
const MAX_BYTES = 10 * 1024 * 1024 // keep in step with signedDriver({ maxRequestBytes })
const encoder = new TextEncoder()

export async function signDelivery(raw, from, to, oversize, secret, t) {
  // HMAC-SHA256 over `${t}.` ++ canonical, canonical = framing ++ raw bytes.
  const prefix = encoder.encode(`${t}.`)
  const head = encoder.encode(`basalt-inbound-v1\n${from}\n${to}\n${oversize ?? ''}\n`)
  const signed = new Uint8Array(prefix.length + head.length + raw.length)
  signed.set(prefix)
  signed.set(head, prefix.length)
  signed.set(raw, prefix.length + head.length)
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed))
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  const headers = {
    'content-type': 'message/rfc822',
    'x-basalt-signature': `t=${t},v1=${hex}`,
    'x-basalt-mail-from': from,
    'x-basalt-mail-to': to,
  }
  if (oversize !== undefined) headers['x-basalt-mail-oversize'] = String(oversize)
  return headers
}

export default {
  async email(message, env) {
    // Over the ceiling, only a signed notice with the size is sent.
    const oversize = message.rawSize > MAX_BYTES ? message.rawSize : undefined
    const raw = oversize === undefined ? new Uint8Array(await new Response(message.raw).arrayBuffer()) : new Uint8Array(0)
    const t = Math.floor(Date.now() / 1000)
    const headers = await signDelivery(raw, message.from, message.to, oversize, env.BASALT_INBOUND_SECRET, t)
    const res = await fetch(env.BASALT_INBOUND_URL, { method: 'POST', body: raw, headers })
    // Throwing makes Email Routing answer the sending server with a temporary
    // failure, so it retries later: right for a 5xx, and for a 401, which
    // means the two secrets disagree (an operator error a retry can outlive).
    if (res.status >= 500 || res.status === 401) throw new Error(`inbound mail endpoint answered ${res.status}`)
    // Any other 4xx is permanent (malformed, over a limit): bounce it.
    if (res.status >= 400) message.setReject(`rejected (${res.status})`)
  },
}
