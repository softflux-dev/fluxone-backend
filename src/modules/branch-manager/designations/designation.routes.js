import { Router } from 'express'
import {
  addDesignation,
  designationDetail,
  designationsList,
  patchDesignation,
  removeDesignation,
} from './designation.controller.js'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { requirePermission } from '../../../middlewares/role.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import {
  createDesignationSchema,
  designationIdParamsSchema,
  listDesignationsSchema,
  updateDesignationSchema,
} from './designation.validator.js'

const router = Router()

router.get(
  '/',
  requirePermission('designations:read'),
  validate(listDesignationsSchema),
  asyncHandler(designationsList),
)
router.post(
  '/',
  requirePermission('designations:write'),
  validate(createDesignationSchema),
  asyncHandler(addDesignation),
)
router.get(
  '/:id',
  requirePermission('designations:read'),
  validate(designationIdParamsSchema),
  asyncHandler(designationDetail),
)
router.patch(
  '/:id',
  requirePermission('designations:write'),
  validate(updateDesignationSchema),
  asyncHandler(patchDesignation),
)
router.delete(
  '/:id',
  requirePermission('designations:write'),
  validate(designationIdParamsSchema),
  asyncHandler(removeDesignation),
)

export default router
