import { Router } from 'express'
import { employees, branches, branchInventory } from './lookup.controller.js'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { requirePermission } from '../../../middlewares/role.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import { branchInventoryQuerySchema, employeeLookupSchema } from './lookup.validator.js'

const router = Router()

router.get(
  '/employees',
  requirePermission('staff:lookup'),
  validate(employeeLookupSchema),
  asyncHandler(employees),
)
router.get('/branches', requirePermission('stock:read'), asyncHandler(branches))
router.get(
  '/branch-inventory',
  requirePermission('stock:read'),
  validate(branchInventoryQuerySchema),
  asyncHandler(branchInventory),
)

export default router
