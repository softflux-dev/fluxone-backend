import { z } from 'zod'
import { empty } from '../shared.validator.js'

export const listStockRequestsSchema = z.object({
  body: empty,
  params: empty,
  query: z.object({
    status: z.enum(['open', 'closed']).optional(),
  }),
})

export const createStockRequestSchema = z.object({
  body: z.object({
    productId: z.string().uuid(),
    kind: z.enum(['alert', 'request']),
    // BM enters how many units to request (whole numbers only)
    remainingQuantity: z.coerce.number().int().positive(),
    branchId: z.string().uuid().optional(),
  }),
  query: empty,
  params: empty,
})
