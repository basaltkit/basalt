import { describe, expect, it } from 'vitest'
import { escapeHtml, scriptJson, pageCsp, cspHash } from '../src/index.js'

describe('escapeHtml', () => {
  it('escapes text and both attribute quote styles', () => {
    expect(escapeHtml(`<img src=x onerror="pwn()" data-a='1'>&`)).toBe(
      '&lt;img src=x onerror=&quot;pwn()&quot; data-a=&#39;1&#39;&gt;&amp;',
    )
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(42)).toBe('42')
  })
})

describe('scriptJson', () => {
  it('cannot be broken out of an inline <script> block', () => {
    const out = scriptJson({ title: '</script><svg onload=alert(1)>' })
    expect(out).not.toContain('</script>')
    expect(out).toContain('\\u003c/script>')
    expect(JSON.parse(out.replace(/\\u003c/g, '<'))).toEqual({ title: '</script><svg onload=alert(1)>' })
  })

  it('escapes U+2028/U+2029 (valid JSON, illegal in JS strings)', () => {
    expect(scriptJson('a\u2028b\u2029c')).toBe('"a\\u2028b\\u2029c"')
  })
})

describe('pageCsp', () => {
  it('locks everything down and allows the inline script only by hash', () => {
    const script = 'const API = "/x";'
    const csp = pageCsp({ scripts: [script] })
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain(`script-src ${cspHash(script)}`)
    expect(csp).toContain("style-src 'unsafe-inline'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  it('adds extra connect origins for absolute API bases', () => {
    expect(pageCsp({ connect: ['https://api.example.com'] })).toContain(
      "connect-src 'self' https://api.example.com",
    )
  })

  it('with no scripts, script-src is none', () => {
    expect(pageCsp()).toContain("script-src 'none'")
  })
})
