import { Router } from 'express'
import { alerts, overview, stockGraph } from './dashboard.controller.js'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { requirePermission } from '../../../middlewares/role.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import { dashboardAlertsQuerySchema, dashboardQuerySchema } from './dashboard.validator.js'

const router = Router()

router.get('/overview', requirePermission('dashboard:read'), asyncHandler(overview))
router.get(
  '/alerts',
  requirePermission('dashboard:read'),
  validate(dashboardAlertsQuerySchema),
  asyncHandler(alerts),
)
router.get('/stock-graph', requirePermission('dashboard:read'), validate(dashboardQuerySchema), asyncHandler(stockGraph))

export default router
