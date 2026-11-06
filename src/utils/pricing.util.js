/**
 * Shared pricing helpers — keep Admin Tax & Profit, IM catalog, and create flows aligned.
 *
 * Canonical Final: selling → −discount% → +tax%
 * Cost-based helpers remain for bulk-profit / suggested selling only — not labeled Final.
 */

/** Auto selling price from purchase + profit % (whole currency units). */
export function sellingFromPurchase(purchase, profitPercent) {
  const p = Number(purchase) || 0
  const r = Number(profitPercent) || 0
  return Math.round(p * (1 + r / 100))
}

/**
 * Suggested / legacy cost-based total (not customer Final).
 * (cost + cost×profit%) + tax on that subtotal.
 */
export function finalPriceFromCost(cost, profitPercent, taxPercent) {
  const c = Number(cost) || 0
  const profitPct = Number(profitPercent) || 0
  const taxPct = Number(taxPercent) || 0
  const profitAmount = (c * profitPct) / 100
  const subTotal = c + profitAmount
  const taxAmount = (subTotal * taxPct) / 100
  return Math.round((subTotal + taxAmount) * 100) / 100
}

/**
 * Canonical Final (JS mirror of product list SQL):
 * selling × (1 − discount%) × (1 + tax%), rounded to whole units.
 */
export function finalPriceFromSelling(selling, discountPercent, taxPercent) {
  const s = Number(selling) || 0
  const d = Number(discountPercent) || 0
  const t = Number(taxPercent) || 0
  return Math.round(s * (1 - d / 100) * (1 + t / 100))
}

/** Actual margin amount: selling − purchase. */
export function actualMarginAmount(purchase, selling) {
  const p = Number(purchase) || 0
  const s = Number(selling) || 0
  return Math.round((s - p) * 100) / 100
}

/** Actual margin % on purchase; 0 when purchase is 0. */
export function actualMarginPercent(purchase, selling) {
  const p = Number(purchase) || 0
  if (p <= 0) return 0
  const s = Number(selling) || 0
  return Math.round(((s - p) / p) * 10000) / 100
}
