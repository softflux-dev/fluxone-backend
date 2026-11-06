import { z } from 'zod'
import { empty, idParams } from '../branch-manager/shared.validator.js'

export const listNotificationsSchema = z.object({
  body: empty,
  query: z.object({
    unreadOnly: z.preprocess(
      (value) => (value === '' || value === null || value === undefined ? undefined : value),
      z.enum(['true', 'false']).optional(),
    ),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
  params: empty,
})

export const notificationIdSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})
