import { z } from 'zod'
import { empty, paginationQuery } from '../shared.validator.js'

export const employeeLookupSchema = z.object({
  body: empty,
  params: empty,
  query: paginationQuery.extend({
    q: z.string().optional(),
  }),
})

export const branchInventoryQuerySchema = z.object({
  body: empty,
  params: empty,
  query: paginationQuery.extend({
    branchId: z.string().uuid().optional(),
    productId: z.string().uuid().optional(),
  }),
})
