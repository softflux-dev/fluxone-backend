import { Router } from 'express'
import { approvalsList, approvalsResolve } from './pricing.controller.js'
import { listApprovalsSchema, resolveApprovalsSchema } from './pricing.validator.js'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { requirePermission } from '../../../middlewares/role.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'

const router = Router()

// IM approves/rejects POS (Local Admin) price changes; BM may view (stock:read) but not resolve.
router.get('/', requirePermission('stock:read'), validate(listApprovalsSchema), asyncHandler(approvalsList))
router.post('/resolve', requirePermission('stock:write'), validate(resolveApprovalsSchema), asyncHandler(approvalsResolve))

export default router
