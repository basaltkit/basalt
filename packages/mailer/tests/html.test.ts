import { describe, expect, it } from 'vitest'
import { escapeHtml, html, raw } from '../src/index.js'

/**
 * S-4 (review 2026-08-b): the safe path is the default path. `html\`\`` escapes
 * every interpolation so user data in a mail body can't inject markup.
 */
describe('escapeHtml', () => {
  it('neutralizes the HTML metacharacters', () => {
    expect(escapeHtml(`<script>alert(1)</script>`)).toBe(
      '&#60;script&#62;alert(1)&#60;/script&#62;',
    )
    expect(escapeHtml(`" onmouseover="x`)).toBe('&#34; onmouseover&#61;&#34;x'.replace('&#61;', '='))
  })
})

describe('html tagged template', () => {
  it('escapes interpolated user data — <script> is rendered inert', () => {
    const name = '<script>steal()</script>'
    const body = String(html`<h1>Hello ${name}</h1>`)
    expect(body).toBe('<h1>Hello &#60;script&#62;steal()&#60;/script&#62;</h1>')
    expect(body).not.toContain('<script>')
  })

  it('escapes attribute-breaking quotes', () => {
    const cls = '" onload="alert(1)'
    const body = String(html`<div class="${cls}"></div>`)
    expect(body).not.toContain('onload="alert(1)"')
    expect(body).toContain('&#34;')
  })

  it('renders arrays of nested templates item-by-item (composes, no double-escape) and drops null/undefined', () => {
    expect(String(html`<ul>${['<b>', 'x'].map((s) => html`<li>${s}</li>`)}</ul>`)).toBe(
      '<ul><li>&#60;b&#62;</li><li>x</li></ul>',
    )
    expect(String(html`a${null}b${undefined}c`)).toBe('abc')
  })

  it('raw() passes trusted markup through (the only escape hatch)', () => {
    expect(String(html`<p>${raw('<b>bold</b>')} and ${'<b>not</b>'}</p>`)).toBe(
      '<p><b>bold</b> and &#60;b&#62;not&#60;/b&#62;</p>',
    )
  })

  it('the static template chrome is never escaped', () => {
    expect(String(html`<h1>Hi ${'Ada'}</h1>`)).toBe('<h1>Hi Ada</h1>')
  })
})
