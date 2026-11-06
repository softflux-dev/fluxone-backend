import { z } from 'zod'
import { empty, idParams, optionalString, paginationQuery } from '../shared.validator.js'

const activeFilter = z.enum(['active', 'inactive', 'all']).optional().default('active')

export const listDesignationsSchema = z.object({
  body: empty,
  params: empty,
  query: paginationQuery.extend({
    q: optionalString,
    active: activeFilter,
  }),
})

export const createDesignationSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(120),
  }),
  query: empty,
  params: empty,
})

export const updateDesignationSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(120).optional(),
    isActive: z.coerce.boolean().optional(),
  }),
  query: empty,
  params: idParams,
})

export const designationIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})
