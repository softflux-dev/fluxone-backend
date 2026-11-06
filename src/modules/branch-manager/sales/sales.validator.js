import { z } from 'zod'
import { empty, idParams, optionalString, optionalUuid } from '../shared.validator.js'

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')

export const listSalesSchema = z.object({
  body: empty,
  params: empty,
  query: z
    .object({
      q: optionalString,
      // Prefer from/to; legacy `date` = single day.
      date: isoDate.optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      categoryId: optionalUuid,
      subcategoryId: optionalUuid,
      productId: optionalUuid,
      variantId: optionalUuid,
    })
    .superRefine((query, ctx) => {
      const from = query.from || query.date
      const to = query.to || query.date
      if (from && to && from > to) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['to'],
          message: 'to must be on or after from',
        })
      }
    }),
})

export const refundSaleSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})
