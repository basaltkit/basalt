import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BRANDING,
  MemoryBrandingStore,
  mergeBranding,
  resolveBranding,
  brandingCssVars,
  brandingStyleSheet,
  defineDashboard,
  metricsSection,
  type Branding,
} from '../src/index.js'

const acme: Branding = {
  productName: 'Acme Console',
  logoUrl: 'https://acme.test/logo.svg',
  colors: { primary: '#5b21b6', accent: '#f59e0b' },
  supportEmail: 'help@acme.test',
}

describe('mergeBranding', () => {
  it('layers a tenant brand over the default, per field', () => {
    const merged = mergeBranding(DEFAULT_BRANDING, { productName: 'Acme', colors: { primary: '#000' } })
    expect(merged.productName).toBe('Acme')
    expect(merged.colors).toEqual({ primary: '#000' })
  })

  it('deep-merges colours and cssVars rather than replacing them', () => {
    const base: Branding = { productName: 'Base', colors: { primary: '#111', accent: '#222' } }
    const merged = mergeBranding(base, { colors: { accent: '#999' } })
    expect(merged.colors).toEqual({ primary: '#111', accent: '#999' }) // primary kept
  })

  it('returns the base unchanged when there is no override', () => {
    expect(mergeBranding(DEFAULT_BRANDING, null)).toBe(DEFAULT_BRANDING)
  })
})

describe('resolveBranding', () => {
  it('falls back to the default for an unbranded tenant', async () => {
    const store = new MemoryBrandingStore()
    expect(await resolveBranding(store, 'nobody')).toEqual(DEFAULT_BRANDING)
  })

  it('returns the tenant brand merged over the fallback', async () => {
    const store = new MemoryBrandingStore()
    await store.set('acme', acme)
    const resolved = await resolveBranding(store, 'acme')
    expect(resolved.productName).toBe('Acme Console')
    expect(resolved.colors?.primary).toBe('#5b21b6')
  })
})

describe('brandingCssVars / brandingStyleSheet', () => {
  it('maps colours and extra cssVars to custom properties', () => {
    const vars = brandingCssVars({ ...acme, cssVars: { '--radius': '8px' } })
    expect(vars).toEqual({
      '--brand-primary': '#5b21b6',
      '--brand-accent': '#f59e0b',
      '--radius': '8px',
    })
  })

  it('renders a :root stylesheet string', () => {
    const css = brandingStyleSheet({ productName: 'X', colors: { primary: '#abc' } })
    expect(css).toBe(':root {\n  --brand-primary: #abc;\n}')
  })
})

describe('Dashboard branding', () => {
  it('derives the title from the product name and carries the brand', () => {
    const dash = defineDashboard({ branding: acme, sections: [metricsSection()] })
    expect(dash.title).toBe('Acme Console')
    expect(dash.branding.logoUrl).toBe('https://acme.test/logo.svg')
  })

  it('an explicit title still wins; default brand applies otherwise', () => {
    expect(defineDashboard({ title: 'Ops', sections: [] }).title).toBe('Ops')
    expect(defineDashboard({ sections: [] }).branding).toBe(DEFAULT_BRANDING)
  })
})
