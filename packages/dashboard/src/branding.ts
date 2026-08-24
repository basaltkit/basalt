/**
 * White-label branding for the admin shell. Pure and browser-safe — the model
 * is data, the helpers turn it into CSS custom properties a shell injects. A
 * per-tenant {@link BrandingStore} lets each tenant ship their own product name,
 * logo and colours over a default brand.
 */

export interface BrandColors {
  /** Primary brand colour (buttons, active nav). → `--brand-primary`. */
  primary?: string
  /** Secondary/accent colour. → `--brand-accent`. */
  accent?: string
  /** Page background. → `--brand-bg`. */
  background?: string
  /** Body text colour. → `--brand-fg`. */
  foreground?: string
}

export interface Branding {
  /** Product/company name in the header and document title. */
  productName: string
  /** Logo URL (light theme). */
  logoUrl?: string
  /** Logo URL for dark theme; falls back to `logoUrl`. */
  logoDarkUrl?: string
  /** Favicon URL. */
  faviconUrl?: string
  /** Brand colours, mapped to CSS custom properties. */
  colors?: BrandColors
  /** Support email shown in the footer. */
  supportEmail?: string
  /** Support / docs link. */
  supportUrl?: string
  /** Advanced theming: extra CSS custom properties (name → value). */
  cssVars?: Record<string, string>
}

/** The neutral fallback brand used when a tenant has none. */
export const DEFAULT_BRANDING: Branding = { productName: 'Admin' }

export interface BrandingStore {
  get(tenantId: string): Promise<Branding | null>
  set(tenantId: string, branding: Branding): Promise<void>
}

export class MemoryBrandingStore implements BrandingStore {
  private readonly brands = new Map<string, Branding>()
  async get(tenantId: string): Promise<Branding | null> {
    const found = this.brands.get(tenantId)
    return found ? { ...found } : null
  }
  async set(tenantId: string, branding: Branding): Promise<void> {
    this.brands.set(tenantId, { ...branding })
  }
}

/** Layer a tenant's branding over a base, field by field (most-specific wins). */
export function mergeBranding(base: Branding, override: Partial<Branding> | null | undefined): Branding {
  if (!override) return base
  const merged: Branding = { ...base, ...override }
  const colors = { ...base.colors, ...override.colors }
  if (Object.keys(colors).length > 0) merged.colors = colors
  const cssVars = { ...base.cssVars, ...override.cssVars }
  if (Object.keys(cssVars).length > 0) merged.cssVars = cssVars
  return merged
}

/** Resolve a tenant's effective branding: their overrides merged over `fallback`. */
export async function resolveBranding(
  store: BrandingStore,
  tenantId: string,
  fallback: Branding = DEFAULT_BRANDING,
): Promise<Branding> {
  return mergeBranding(fallback, await store.get(tenantId))
}

/** A valid CSS custom-property name: `--` followed by identifier chars only. */
const CSS_VAR_NAME = /^--[A-Za-z0-9_-]+$/
/**
 * Characters that let a value break out of a `--name: value;` declaration or the
 * surrounding `<style>` element. Branding is tenant-controlled (white-label), so
 * any value carrying these is dropped rather than escaped — escaping is unsafe in
 * CSS context (`</style>` still terminates the element).
 */
const CSS_VALUE_FORBIDDEN = /[<>{}();@\\"'`\r\n\t\0]|\/\*|\*\//

function isSafeCssValue(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !CSS_VALUE_FORBIDDEN.test(value)
}

/**
 * The brand's CSS custom properties (colours first, then any `cssVars`).
 * Names and values are strictly validated — an unsafe entry is silently dropped,
 * never emitted — because the output is injected into a `<style>` element and the
 * data is tenant-controlled. Even so, serve the shell under a CSP that forbids
 * inline styles where possible, as defence in depth.
 */
export function brandingCssVars(branding: Branding): Record<string, string> {
  const out: Record<string, string> = {}
  const colors = branding.colors ?? {}
  const named: Array<[string, string | undefined]> = [
    ['--brand-primary', colors.primary],
    ['--brand-accent', colors.accent],
    ['--brand-bg', colors.background],
    ['--brand-fg', colors.foreground],
  ]
  for (const [name, value] of named) {
    if (isSafeCssValue(value)) out[name] = value
  }
  for (const [name, value] of Object.entries(branding.cssVars ?? {})) {
    if (CSS_VAR_NAME.test(name) && isSafeCssValue(value)) out[name] = value
  }
  return out
}

/**
 * Render the brand's custom properties as a `:root { … }` stylesheet string.
 * Only entries that pass {@link brandingCssVars} validation appear; the selector
 * itself is fixed by the caller (never derived from branding).
 */
export function brandingStyleSheet(branding: Branding, selector = ':root'): string {
  const entries = Object.entries(brandingCssVars(branding))
  const body = entries.map(([name, value]) => `  ${name}: ${value};`).join('\n')
  return `${selector} {\n${body}\n}`
}
