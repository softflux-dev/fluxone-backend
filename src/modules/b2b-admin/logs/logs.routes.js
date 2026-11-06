import { Router } from 'express'
import {
  adminLogActors,
  adminLogFilterOptions,
  adminLogsList,
} from './logs.controller.js'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { requirePermission } from '../../../middlewares/role.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import {
  adminLogActorsQuerySchema,
  adminLogFilterOptionsQuerySchema,
  listAdminLogsQuerySchema,
} from './logs.validator.js'

const router = Router()

// Immutable audit trail — GET only. Never add PATCH/PUT/DELETE for log rows.
router.get(
  '/',
  requirePermission('admin-logs:read'),
  validate(listAdminLogsQuerySchema),
  asyncHandler(adminLogsList),
)

router.get(
  '/actors',
  requirePermission('admin-logs:read'),
  validate(adminLogActorsQuerySchema),
  asyncHandler(adminLogActors),
)

router.get(
  '/filter-options',
  requirePermission('admin-logs:read'),
  validate(adminLogFilterOptionsQuerySchema),
  asyncHandler(adminLogFilterOptions),
)

export default router
