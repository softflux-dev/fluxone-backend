import { z } from 'zod'
import { empty, idParams, optionalString, optionalUuid } from '../shared.validator.js'

export const listDiscountsSchema = z.object({
  body: empty,
  params: empty,
  query: z.object({
    categoryId: optionalUuid,
    // Search by offer name or id fragment (OFF-… / uuid)
    q: optionalString,
  }),
})

export const createDiscountSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(120),
    percent: z.coerce.number().min(0).max(100),
    categoryId: optionalUuid,
  }),
  query: empty,
  params: empty,
})

export const updateDiscountSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(120),
    percent: z.coerce.number().min(0).max(100),
    categoryId: optionalUuid,
  }),
  query: empty,
  params: idParams,
})

export const discountIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})
