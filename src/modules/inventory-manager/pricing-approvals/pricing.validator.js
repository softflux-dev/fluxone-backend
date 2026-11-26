import { z } from 'zod'
import { empty } from '../shared.validator.js'

export const listApprovalsSchema = z.object({
  body: empty,
  params: empty,
  query: z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'superseded']).optional(),
    branchId: z.string().uuid().optional(),
  }),
})

export const resolveApprovalsSchema = z.object({
  body: z.object({
    action: z.enum(['approve', 'reject']),
    ids: z.array(z.string().uuid()).min(1).max(200),
  }),
  params: empty,
  query: empty,
})
