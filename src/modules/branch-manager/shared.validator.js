import { z } from 'zod'
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../utils/pagination.util.js'

export const empty = z.object({}).optional()

export const optionalUuid = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.string().uuid().optional(),
)

export const optionalString = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.string().optional(),
)

export const timeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Invalid time (HH:MM or HH:MM:SS)')

export const optionalTime = z.preprocess((value) => {
  if (value === undefined) return undefined // omit → no change on PATCH
  if (value === '' || value === null) return null // clear
  return value
}, z.union([timeString, z.null()]).optional())

export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
})

export const idParams = z.object({
  id: z.string().uuid(),
})

export const dateRangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Single-day shorthand → treated as from=to when from/to omitted */
  date: z.preprocess(
    (value) => (value === '' || value === null || value === undefined ? undefined : value),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  ),
  branchId: optionalUuid,
})
