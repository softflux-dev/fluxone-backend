import { z } from 'zod'
import { empty, paginationQuery } from '../../branch-manager/shared.validator.js'
import { looseUuidWithMessage } from '../../../utils/zodFields.util.js'

const optionalString = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.string().optional(),
)

const looseUuid = looseUuidWithMessage('Invalid policy id')

export const listPoliciesQuerySchema = z.object({
  body: empty,
  params: empty,
  query: paginationQuery.extend({
    q: optionalString,
    category: optionalString,
  }),
})

export const policyIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: z.object({
    id: looseUuid,
  }),
})

export const createPolicySchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(200),
    detail: z.string().trim().min(1).max(10000),
    category: optionalString,
    isActive: z
      .preprocess((value) => {
        if (value === 'true' || value === true) return true
        if (value === 'false' || value === false) return false
        return undefined
      }, z.boolean().optional())
      .optional(),
    // When true, POS includes this policy on printed sale slips
    printOnSlip: z
      .preprocess((value) => {
        if (value === 'true' || value === true) return true
        if (value === 'false' || value === false) return false
        return undefined
      }, z.boolean().optional())
      .optional(),
  }),
  query: empty,
  params: empty,
})

export const updatePolicySchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    detail: z.string().trim().min(1).max(10000).optional(),
    category: optionalString,
    isActive: z
      .preprocess((value) => {
        if (value === 'true' || value === true) return true
        if (value === 'false' || value === false) return false
        return undefined
      }, z.boolean().optional())
      .optional(),
    printOnSlip: z
      .preprocess((value) => {
        if (value === 'true' || value === true) return true
        if (value === 'false' || value === false) return false
        return undefined
      }, z.boolean().optional())
      .optional(),
  }),
  query: empty,
  params: z.object({
    id: looseUuid,
  }),
})
