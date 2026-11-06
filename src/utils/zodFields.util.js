import { z } from 'zod'

/** UUID-shaped ids (including legacy seed ids that are not RFC variant-strict). */
export const LOOSE_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

export function looseUuidWithMessage(message = 'Invalid id') {
  return z.string().regex(LOOSE_UUID_RE, message)
}

export const looseUuid = looseUuidWithMessage('Invalid id')

/** Whole-number percentage 0–100 (Admin Tax & Profit + product tax/profit). */
export const percentField = z.coerce.number().int().min(0).max(100)

export const optionalPercentField = percentField.optional()
