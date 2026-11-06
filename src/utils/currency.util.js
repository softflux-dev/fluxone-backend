import { tenantQuery } from '../config/db.js'

// Supported system currencies (ISO 4217 codes)

export const SUPPORTED_CURRENCIES = [
  { code: 'PKR', symbol: '₨', label: 'PKR (₨)' },
  { code: 'USD', symbol: '$', label: 'USD ($)' },
  { code: 'EUR', symbol: '€', label: 'EUR (€)' },
  { code: 'GBP', symbol: '£', label: 'GBP (£)' },
  { code: 'SAR', symbol: '﷼', label: 'SAR (﷼)' },
]

export const DEFAULT_CURRENCY = 'PKR'

const CODE_SET = new Set(SUPPORTED_CURRENCIES.map((c) => c.code))

export function isSupportedCurrency(code) {
  return CODE_SET.has(String(code || '').toUpperCase())
}

export function normalizeCurrency(code) {
  const upper = String(code || '').trim().toUpperCase()
  return isSupportedCurrency(upper) ? upper : DEFAULT_CURRENCY
}

export function getCurrencyMeta(code) {
  const normalized = normalizeCurrency(code)
  return SUPPORTED_CURRENCIES.find((c) => c.code === normalized) || SUPPORTED_CURRENCIES[0]
}

// Display-only formatting helper — FX conversion lives in fx.util.js / settings currency change
export function formatMoney(amount, currencyCode = DEFAULT_CURRENCY) {
  const n = Number(amount) || 0
  const code = normalizeCurrency(currencyCode)
  const meta = getCurrencyMeta(code)
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: code,
      maximumFractionDigits: 2,
    }).format(n)
  } catch {
    return `${meta.symbol}${n.toLocaleString()}`
  }
}

/**
 * Compact money for activity / admin log sentences.
 * PKR → "Rs. 50" (QA tc-logs-01a); other codes use their symbol.
 */
export function formatMoneyLabel(amount, currencyCode = DEFAULT_CURRENCY) {
  const n = Number(amount)
  const code = normalizeCurrency(currencyCode)
  const value = Number.isFinite(n) ? n : 0
  const amountStr =
    Math.trunc(value) === value
      ? String(Math.trunc(value))
      : value.toFixed(2).replace(/\.?0+$/, '')
  if (code === 'PKR') return `Rs. ${amountStr}`
  const meta = getCurrencyMeta(code)
  return `${meta.symbol}${amountStr}`
}

export async function getTenantCurrencyCode(tenantId) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT COALESCE(default_currency, $2) AS "defaultCurrency"
      FROM tenants
      WHERE id = $1
      LIMIT 1
    `,
    [DEFAULT_CURRENCY],
  )
  return normalizeCurrency(rows[0]?.defaultCurrency || DEFAULT_CURRENCY)
}

/**
 * Rewrite legacy hardcoded £ amounts in stored activity action text when tenant is PKR
 * (older writers used £ regardless of settings — QA tc-logs-01a).
 */
export function rewriteLegacyLogCurrencyText(text, currencyCode = DEFAULT_CURRENCY) {
  const raw = String(text || '')
  if (!raw) return raw
  const code = normalizeCurrency(currencyCode)
  if (code === 'PKR') {
    return raw.replace(/£(\d+(?:\.\d+)?)/g, 'Rs. $1')
  }
  const meta = getCurrencyMeta(code)
  if (meta.symbol && meta.symbol !== '£') {
    return raw.replace(/£(\d+(?:\.\d+)?)/g, `${meta.symbol}$1`)
  }
  return raw
}
