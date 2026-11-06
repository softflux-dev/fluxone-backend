import { normalizeImageUrl } from '../../../utils/uploadUrl.util.js'

export function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

const LOOSE_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function isLooseUuid(value) {
  return typeof value === 'string' && LOOSE_UUID_RE.test(value)
}

export function mapUniqueViolation(err, message = 'Item code or barcode already exists') {
  if (err?.code === '23505') throw httpError(409, message)
  throw err
}

export function assertSellingGtePurchase(purchasePrice, sellingPrice, label = 'Product') {
  const purchase = Number(purchasePrice) || 0
  const selling = Number(sellingPrice) || 0
  if (selling < purchase) {
    throw httpError(
      422,
      `${label}: selling price must be greater than or equal to purchase price`,
    )
  }
}

/** Per-SKU discount/offer (Discount & Offer are one promo). */
export function resolveVariantPromo(variant = {}, parentPayload = {}) {
  const hasOwnOffer = Object.prototype.hasOwnProperty.call(variant, 'offerId')
  const hasOwnDiscount = Object.prototype.hasOwnProperty.call(variant, 'discountPercent')
  const offerId = hasOwnOffer ? variant.offerId || null : parentPayload.offerId || null
  let discountPercent = hasOwnDiscount
    ? variant.discountPercent
    : parentPayload.discountPercent ?? null
  if (discountPercent === undefined || discountPercent === '') discountPercent = null
  // No linked offer → no discount % (one promo model)
  if (!offerId) discountPercent = null
  return { offerId, discountPercent }
}

// Branch scope: null = all branches (B2B admin)
export function branchClause(alias, paramIndex) {
  const col = alias ? `${alias}.branch_id` : 'branch_id'
  return `AND ($${paramIndex}::uuid IS NULL OR ${col} = $${paramIndex})`
}

export function mapCategoryRow(row) {
  if (!row) return null
  return {
    ...row,
    imageUrl: normalizeImageUrl(row.imageUrl),
  }
}
