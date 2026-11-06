import { z } from 'zod'
import { empty, optionalString, optionalUuid, paginationQuery } from '../shared.validator.js'
import { ACTIVITY_SOURCES } from '../../../utils/activityLog.util.js'

export const listActivityLogsSchema = z.object({
  body: empty,
  params: empty,
  query: paginationQuery.extend({
    branchId: optionalUuid,
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    action: optionalString,
    source: z.enum(ACTIVITY_SOURCES).optional(),
    q: optionalString,
  }),
})
