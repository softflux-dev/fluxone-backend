import { z } from 'zod'
import { empty, optionalString, optionalUuid, paginationQuery } from '../../branch-manager/shared.validator.js'
import { looseUuid, percentField } from '../../../utils/zodFields.util.js'

const dateField = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD').optional(),
)

const sortEnum = z.enum(['all', 'top_sales', 'top_profit', 'slow_moving']).default('all')

export const listTaxProfitQuerySchema = z.object({
  body: empty,
  params: empty,
  query: paginationQuery.extend({
    q: optionalString,
    branchId: optionalUuid,
    categoryId: optionalUuid,
    subcategoryId: optionalUuid,
    productId: optionalUuid,
    variantId: optionalUuid,
    from: dateField,
    to: dateField,
    sort: z.preprocess(
      (value) => (value === '' || value === null || value === undefined ? 'all' : value),
      sortEnum,
    ),
  }),
})

export const taxProfitMetaSchema = z.object({
  body: empty,
  params: empty,
  query: empty,
})

export const bulkProfitSchema = z.object({
  body: z.object({
    productIds: z.array(looseUuid).min(1).max(500),
    profitPercent: percentField,
  }),
  query: empty,
  params: empty,
})

export const bulkTaxSchema = z.object({
  body: z.object({
    productIds: z.array(looseUuid).min(1).max(500),
    taxPercent: percentField,
  }),
  query: empty,
  params: empty,
})

// Defaults apply to newly created products only — never bulk-update existing catalog.
export const updateDefaultsSchema = z.object({
  body: z
    .object({
      defaultProfitPercent: percentField.optional(),
      defaultTaxPercent: percentField.optional(),
    })
    .refine(
      (data) =>
        data.defaultProfitPercent !== undefined || data.defaultTaxPercent !== undefined,
      {
        message: 'Must provide either defaultProfitPercent or defaultTaxPercent',
      },
    ),
  query: empty,
  params: empty,
})
