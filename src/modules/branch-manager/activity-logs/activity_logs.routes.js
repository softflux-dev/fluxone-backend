import { Router } from 'express'
import { activityLogsList } from './activity_logs.controller.js'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { requirePermission } from '../../../middlewares/role.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import { listActivityLogsSchema } from './activity_logs.validator.js'

const router = Router()

router.get(
  '/',
  requirePermission('activity-logs:read'),
  validate(listActivityLogsSchema),
  asyncHandler(activityLogsList),
)

export default router
