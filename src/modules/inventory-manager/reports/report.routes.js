import { Router } from 'express'
import {
  inventoryReport,
  lowStockReport,
  purchaseReport,
  stockMovementReport,
} from './report.controller.js'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { requirePermission } from '../../../middlewares/role.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import { reportQuerySchema } from './report.validator.js'

const router = Router()

router.use(requirePermission('reports:read'))
router.get('/inventory', validate(reportQuerySchema), asyncHandler(inventoryReport))
router.get('/stock-movement', validate(reportQuerySchema), asyncHandler(stockMovementReport))
router.get('/purchases', validate(reportQuerySchema), asyncHandler(purchaseReport))
router.get('/low-stock', validate(reportQuerySchema), asyncHandler(lowStockReport))

export default router
