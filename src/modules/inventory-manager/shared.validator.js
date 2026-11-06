import { z } from 'zod'
import { PRODUCT_STATUS, PRODUCT_TYPES } from '../../config/constants.js'
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../utils/pagination.util.js'
import {
  looseUuid,
  optionalPercentField,
  percentField,
} from '../../utils/zodFields.util.js'

export { looseUuid, optionalPercentField, percentField }

export const empty = z.object({}).optional()

// Treat "" as omitted so optional UUID fields don't 422 with Invalid uuid.
export const optionalUuid = z.preprocess(
  (value) => (value === '' || value === null ? undefined : value),
  z.string().uuid().optional(),
)

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
})

// active | inactive | all — default active for clean lists
export const activeFilter = z
  .enum(['active', 'inactive', 'all'])
  .optional()
  .default('active')

export const catalogFilters = z.object({
  q: z.string().optional(),
  categoryId: optionalUuid,
  subcategoryId: optionalUuid,
  // Parent product + variant axes (Products / Control / Branch cascade).
  productId: optionalUuid,
  variantTypeId: optionalUuid,
  variantValueId: optionalUuid,
  type: z
    .enum([PRODUCT_TYPES.SINGLE, PRODUCT_TYPES.BUNDLE, PRODUCT_TYPES.VARIANT])
    .optional(),
  scale: z.string().optional(),
  status: z
    .enum([PRODUCT_STATUS.ACTIVE, PRODUCT_STATUS.INACTIVE, 'all', 'open', 'close'])
    .optional()
    .default(PRODUCT_STATUS.ACTIVE)
    .transform((value) => {
      if (value === 'open') return PRODUCT_STATUS.ACTIVE
      if (value === 'close') return PRODUCT_STATUS.INACTIVE
      return value
    }),
})

export const idParams = z.object({
  id: z.string().uuid(),
})

export const optionalBool = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined
  if (value === true || value === 'true' || value === '1' || value === 1) return true
  if (value === false || value === 'false' || value === '0' || value === 0) return false
  return value
}, z.boolean().optional())

// Empty / null → omitted so optional FK fields do not 422.
export const optionalLooseUuid = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  looseUuid.optional(),
)

// Update payloads: null clears FK; undefined/empty omits the field (no change).
export const nullableLooseUuid = z.preprocess(
  (value) => (value === '' || value === undefined ? undefined : value),
  z.union([looseUuid, z.null()]).optional(),
)