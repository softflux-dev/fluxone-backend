import { Router } from 'express'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { requirePermission } from '../../../middlewares/role.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import { decideManagerLeave, managerLeavesList } from './leaves.controller.js'
import { decideManagerLeaveSchema, listManagerLeavesSchema } from './leaves.validator.js'

const router = Router()

// BM self-leave requests awaiting / decided by Admin
router.get(
  '/',
  requirePermission('admin:branches'),
  validate(listManagerLeavesSchema),
  asyncHandler(managerLeavesList),
)
router.patch(
  '/:id/decide',
  requirePermission('admin:branches'),
  validate(decideManagerLeaveSchema),
  asyncHandler(decideManagerLeave),
)

export default router
