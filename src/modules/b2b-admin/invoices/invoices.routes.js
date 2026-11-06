import { Router } from 'express'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import {
  invoiceDetail,
  invoicesList,
  invoicesSummary,
} from './invoices.controller.js'
import {
  invoiceIdParamsSchema,
  invoicesSummarySchema,
  listInvoicesQuerySchema,
} from './invoices.validator.js'

const router = Router()

router.get('/summary', validate(invoicesSummarySchema), asyncHandler(invoicesSummary))
router.get('/', validate(listInvoicesQuerySchema), asyncHandler(invoicesList))
router.get('/:id', validate(invoiceIdParamsSchema), asyncHandler(invoiceDetail))

export default router
