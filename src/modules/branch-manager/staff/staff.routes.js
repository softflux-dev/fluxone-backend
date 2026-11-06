import { Router } from 'express'
import {
  createStaff,
  patchStaff,
  patchStaffStatus,
  reallocateHardware,
  removeStaff,
  staffDetail,
  staffExport,
  staffList,
} from './staff.controller.js'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { requirePermission } from '../../../middlewares/role.middleware.js'
import { upload } from '../../../middlewares/upload.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import {
  createStaffSchema,
  exportStaffSchema,
  listStaffSchema,
  staffIdParamsSchema,
  reallocateHardwareSchema,
  updateStaffSchema,
  updateStaffStatusSchema,
} from './staff.validator.js'

const router = Router()

router.get('/', requirePermission('staff:read'), validate(listStaffSchema), asyncHandler(staffList))
// /export before /:id so "export" is not parsed as a UUID
router.get(
  '/export',
  requirePermission('staff:read'),
  validate(exportStaffSchema),
  asyncHandler(staffExport),
)
router.post(
  '/',
  requirePermission('staff:write'),
  upload.single('image'),
  validate(createStaffSchema),
  asyncHandler(createStaff),
)
router.get(
  '/:id',
  requirePermission('staff:read'),
  validate(staffIdParamsSchema),
  asyncHandler(staffDetail),
)
router.patch(
  '/:id',
  requirePermission('staff:write'),
  upload.single('image'),
  validate(updateStaffSchema),
  asyncHandler(patchStaff),
)
router.post(
  '/:id/reallocate-hardware',
  requirePermission('staff:write'),
  validate(reallocateHardwareSchema),
  asyncHandler(reallocateHardware),
)
router.patch(
  '/:id/status',
  requirePermission('staff:write'),
  validate(updateStaffStatusSchema),
  asyncHandler(patchStaffStatus),
)
router.delete(
  '/:id',
  requirePermission('staff:write'),
  validate(staffIdParamsSchema),
  asyncHandler(removeStaff),
)

export default router
