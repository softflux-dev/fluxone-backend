import { z } from 'zod'
import { empty, paginationQuery } from '../shared.validator.js'

export const dashboardQuerySchema = z.object({
  body: empty,
  params: empty,
  query: z.object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
})

export const dashboardAlertsQuerySchema = z.object({
  body: empty,
  params: empty,
  query: paginationQuery,
})
