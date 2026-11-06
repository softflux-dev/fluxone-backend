import { z } from 'zod'
import { dateRangeQuery, empty, paginationQuery } from '../shared.validator.js'

export const dashboardQuerySchema = z.object({
  body: empty,
  params: empty,
  query: dateRangeQuery,
})

export const dashboardPaginatedQuerySchema = z.object({
  body: empty,
  params: empty,
  query: dateRangeQuery.merge(paginationQuery),
})
