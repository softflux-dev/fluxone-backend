// FX helpers — rates stored as PKR per 1 unit of currency (1 USD = 230 PKR → rateToPkr=230)
import {
  DEFAULT_CURRENCY,
  normalizeCurrency,
  formatMoney,
} from './currency.util.js'

export function convertAmount(amount, fromCode, toCode, ratesToPkr = {}) {
  const from = normalizeCurrency(fromCode)
  const to = normalizeCurrency(toCode)
  const n = Number(amount) || 0
  if (from === to) return n

  const fromRate = Number(ratesToPkr[from] ?? (from === DEFAULT_CURRENCY ? 1 : NaN))
  const toRate = Number(ratesToPkr[to] ?? (to === DEFAULT_CURRENCY ? 1 : NaN))
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || toRate <= 0) {
    return n
  }
  // amount_to = amount_from * (PKR per from) / (PKR per to)
  return (n * fromRate) / toRate
}

export function conversionFactor(fromCode, toCode, ratesToPkr = {}) {
  const from = normalizeCurrency(fromCode)
  const to = normalizeCurrency(toCode)
  if (from === to) return 1
  const fromRate = Number(ratesToPkr[from] ?? (from === DEFAULT_CURRENCY ? 1 : NaN))
  const toRate = Number(ratesToPkr[to] ?? (to === DEFAULT_CURRENCY ? 1 : NaN))
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || toRate <= 0) {
    return 1
  }
  return fromRate / toRate
}

export function sumConverted(rows, amountKey, currencyKey, targetCurrency, ratesToPkr) {
  let total = 0
  for (const row of rows || []) {
    total += convertAmount(row[amountKey], row[currencyKey] || DEFAULT_CURRENCY, targetCurrency, ratesToPkr)
  }
  return total
}

export function formatConverted(amount, fromCode, toCode, ratesToPkr) {
  const converted = convertAmount(amount, fromCode, toCode, ratesToPkr)
  return formatMoney(converted, toCode)
}
