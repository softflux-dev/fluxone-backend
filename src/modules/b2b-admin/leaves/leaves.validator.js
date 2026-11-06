import { z } from 'zod'
import { empty, idParams, optionalUuid } from '../../branch-manager/shared.validator.js'

export const listManagerLeavesSchema = z.object({
  body: empty,
  query: z.object({
    branchId: optionalUuid,
    status: z.preprocess(
      (value) => (value === '' || value === null || value === undefined ? undefined : value),
      z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
    ),
    q: z.preprocess(
      (value) => (value === '' || value === null || value === undefined ? undefined : value),
      z.string().max(120).optional(),
    ),
  }),
  params: empty,
})

export const decideManagerLeaveSchema = z.object({
  body: z.object({
    status: z.enum(['approved', 'rejected']),
    decisionReason: z.string().trim().max(500).optional().nullable(),
  }),
  query: empty,
  params: idParams,
})
