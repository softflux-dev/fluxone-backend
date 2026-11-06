import { z } from 'zod'
import { empty, paginationQuery } from '../shared.validator.js'

export const reportQuerySchema = z.object({
  body: empty,
  params: empty,
  query: paginationQuery.extend({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
})
