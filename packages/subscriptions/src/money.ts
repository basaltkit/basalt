/**
 * Money handling for the subscriptions ecosystem. **All amounts in the public
 * API are integers in the currency's minor unit** — cents, `100 = 1.00`. This
 * is the Stripe/Adyen convention: exact, no floating-point rounding, and no
 * ambiguity about units. Use these helpers to convert at the human boundary
 * (input forms, display) and to validate.
 *
 * ```ts
 * toMinor(5000, 'AOA')      // 500000  (5.000,00 Kz)
 * toMajor(500000, 'AOA')    // 5000
 * formatMoney(500000, 'AOA', 'pt-AO') // "5.000,00 AOA"
 * assertMinorUnits(2999)    // ok      ($29.99)
 * assertMinorUnits(29.99)   // throws
 * ```
 */

/** Minor-unit exponent per ISO 4217 currency. Extend as needed. */
const CURRENCY_DECIMALS: Record<string, number> = {
  AOA: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  BRL: 2,
  ZAR: 2,
  MZN: 2,
  CVE: 2,
  NGN: 2,
  KES: 2,
  JPY: 0,
  XOF: 0,
  XAF: 0,
  CLP: 0,
}

const DEFAULT_DECIMALS = 2

/** Number of minor-unit decimal places for a currency (default 2). */
export function currencyDecimals(currency: string): number {
  return CURRENCY_DECIMALS[currency.toUpperCase()] ?? DEFAULT_DECIMALS
}

/** Convert a major-unit amount (e.g. `5000` Kz) to minor units (`500000`). */
export function toMinor(major: number, currency: string): number {
  return Math.round(major * 10 ** currencyDecimals(currency))
}

/** Convert minor units (`500000`) back to a major-unit amount (`5000` Kz). */
export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** currencyDecimals(currency)
}

/** Format a minor-unit amount for display. Falls back to a plain string if Intl lacks the currency. */
export function formatMoney(minor: number, currency: string, locale = 'en-US'): string {
  const major = toMajor(minor, currency)
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(major)
  } catch {
    return `${major.toFixed(currencyDecimals(currency))} ${currency.toUpperCase()}`
  }
}

/** True when `amount` is a valid minor-unit value (a non-negative integer). */
export function isMinorUnits(amount: number): boolean {
  return Number.isInteger(amount) && amount >= 0
}

/**
 * Throw unless `amount` is a valid minor-unit value. Drivers call this so a
 * major-unit slip (e.g. `29.99` instead of `2999`) fails fast instead of
 * silently under/over-charging.
 */
export function assertMinorUnits(amount: number, label = 'amount'): void {
  if (!isMinorUnits(amount)) {
    throw new RangeError(
      `${label} must be a non-negative integer in minor units (e.g. cents), got ${amount}`,
    )
  }
}
