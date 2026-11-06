import { Router } from 'express'
import {
  downloadReport,
  inventoryStatus,
  overview,
  salesGraph,
  salesSummary,
  staffPerformance,
  fullDashboard,
} from './dashboard.controller.js'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { requirePermission } from '../../../middlewares/role.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import { dashboardPaginatedQuerySchema, dashboardQuerySchema } from './dashboard.validator.js'

const router = Router()

router.get(
  '/',
  requirePermission('branch-dashboard:read'),
  validate(dashboardQuerySchema),
  asyncHandler(fullDashboard),
)

router.get(
  '/overview',
  requirePermission('branch-dashboard:read'),
  validate(dashboardQuerySchema),
  asyncHandler(overview),
)
router.get(
  '/sales-summary',
  requirePermission('branch-dashboard:read'),
  validate(dashboardQuerySchema),
  asyncHandler(salesSummary),
)
router.get(
  '/sales-graph',
  requirePermission('branch-dashboard:read'),
  validate(dashboardQuerySchema),
  asyncHandler(salesGraph),
)
router.get(
  '/staff-performance',
  requirePermission('branch-dashboard:read'),
  validate(dashboardPaginatedQuerySchema),
  asyncHandler(staffPerformance),
)
router.get(
  '/inventory-status',
  requirePermission('branch-dashboard:read'),
  validate(dashboardPaginatedQuerySchema),
  asyncHandler(inventoryStatus),
)
router.get(
  '/report',
  requirePermission('branch-dashboard:read'),
  validate(dashboardQuerySchema),
  asyncHandler(downloadReport),
)

export default router
