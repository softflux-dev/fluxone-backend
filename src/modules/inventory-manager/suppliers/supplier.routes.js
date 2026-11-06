import { Router } from 'express'
import { create, list, remove, setActive, update } from './supplier.controller.js'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { requirePermission } from '../../../middlewares/role.middleware.js'
import { upload } from '../../../middlewares/upload.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import {
  createSupplierSchema,
  listSuppliersSchema,
  setSupplierActiveSchema,
  supplierIdParamsSchema,
  updateSupplierSchema,
} from './supplier.validator.js'

const media = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'signature', maxCount: 1 },
])

const router = Router()

router.get('/', requirePermission('suppliers:read'), validate(listSuppliersSchema), asyncHandler(list))
router.post('/', requirePermission('suppliers:write'), media, validate(createSupplierSchema), asyncHandler(create))
router.patch(
  '/:id',
  requirePermission('suppliers:write'),
  media,
  validate(updateSupplierSchema),
  asyncHandler(update),
)
// Block / Unblock — BM (+ B2B); IM cannot moderate
router.patch(
  '/:id/status',
  requirePermission('suppliers:moderate'),
  validate(setSupplierActiveSchema),
  asyncHandler(setActive),
)
// Hard delete — BM (+ B2B); IM cannot delete (use Block when referenced on orders)
router.delete(
  '/:id',
  requirePermission('suppliers:delete'),
  validate(supplierIdParamsSchema),
  asyncHandler(remove),
)

export default router