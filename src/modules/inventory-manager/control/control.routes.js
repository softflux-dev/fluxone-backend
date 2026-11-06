import { Router } from 'express'
import {
  createAdjustment,
  createDamaged,
  createExpired,
  createOther,
  createStockIn,
  createStockOut,
  createTransfer,
  deleteThreshold,
  exportControl,
  getAlerts,
  getPriceRule,
  getSummary,
  getThresholds,
  importControl,
  listAdjustments,
  listAdjustmentLedger,
  listDailyPrices,
  listDamaged,
  listExpired,
  listOthers,
  listStockIn,
  listStockOut,
  listStockTransfers,
  patchDailyPrice,
  patchPriceRule,
  removeAdjustment,
  removeDamaged,
  removeExpired,
  removeOther,
  saveThreshold,
  stockInFromOrder,
  updateAdjustment,
  updateDamaged,
  updateExpired,
  updateOther,
} from './control.controller.js'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { requirePermission } from '../../../middlewares/role.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import {
  adjustmentSchema,
  controlSummarySchema,
  damagedSchema,
  expiredSchema,
  exportLedgerSchema,
  importControlSchema,
  ledgerIdParamsSchema,
  listLedgerSchema,
  listThresholdsSchema,
  otherSchema,
  patchMovementSchema,
  patchPriceRuleSchema,
  priceRuleSchema,
  stockInFromOrderSchema,
  stockInSchema,
  stockOutSchema,
  thresholdProductParamsSchema,
  transferSchema,
  updateDailyPriceSchema,
  upsertThresholdSchema,
} from './control.validator.js'

const router = Router()

router.get(
  '/summary',
  requirePermission('stock:read'),
  validate(controlSummarySchema),
  asyncHandler(getSummary),
)

// Phase 4 chrome endpoints
router.get(
  '/daily-prices',
  requirePermission('stock:read'),
  asyncHandler(listDailyPrices),
)
router.patch(
  '/daily-prices/:id',
  requirePermission('stock:write'),
  validate(updateDailyPriceSchema),
  asyncHandler(patchDailyPrice),
)
router.get(
  '/thresholds',
  requirePermission('stock:read'),
  validate(listThresholdsSchema),
  asyncHandler(getThresholds),
)
router.post(
  '/thresholds',
  requirePermission('stock:write'),
  validate(upsertThresholdSchema),
  asyncHandler(saveThreshold),
)
router.delete(
  '/thresholds/:id',
  requirePermission('stock:write'),
  validate(thresholdProductParamsSchema),
  asyncHandler(deleteThreshold),
)
router.get('/alerts', requirePermission('stock:read'), asyncHandler(getAlerts))

// Phase 5 — export / import / price utilization rule
router.get(
  '/export',
  requirePermission('stock:read'),
  validate(exportLedgerSchema),
  asyncHandler(exportControl),
)
router.post(
  '/import',
  requirePermission('stock:write'),
  validate(importControlSchema),
  asyncHandler(importControl),
)
router.get(
  '/price-rule',
  requirePermission('stock:read'),
  validate(priceRuleSchema),
  asyncHandler(getPriceRule),
)
router.patch(
  '/price-rule',
  requirePermission('stock:write'),
  validate(patchPriceRuleSchema),
  asyncHandler(patchPriceRule),
)

router.get('/stock-in', requirePermission('stock:read'), validate(listLedgerSchema), asyncHandler(listStockIn))
router.post('/stock-in', requirePermission('stock:write'), validate(stockInSchema), asyncHandler(createStockIn))
router.post(
  '/stock-in/from-order',
  requirePermission('stock:write'),
  validate(stockInFromOrderSchema),
  asyncHandler(stockInFromOrder),
)

router.get('/stock-out', requirePermission('stock:read'), validate(listLedgerSchema), asyncHandler(listStockOut))
router.post('/stock-out', requirePermission('stock:write'), validate(stockOutSchema), asyncHandler(createStockOut))

router.get('/adjustments', requirePermission('stock:read'), validate(listLedgerSchema), asyncHandler(listAdjustments))
router.get(
  '/adjustment-ledger',
  requirePermission('stock:read'),
  validate(listLedgerSchema),
  asyncHandler(listAdjustmentLedger),
)
router.post('/adjustments', requirePermission('stock:write'), validate(adjustmentSchema), asyncHandler(createAdjustment))
router.patch(
  '/adjustments/:id',
  requirePermission('stock:write'),
  validate(patchMovementSchema),
  asyncHandler(updateAdjustment),
)
router.delete(
  '/adjustments/:id',
  requirePermission('stock:write'),
  validate(ledgerIdParamsSchema),
  asyncHandler(removeAdjustment),
)

router.get('/damaged', requirePermission('stock:read'), validate(listLedgerSchema), asyncHandler(listDamaged))
router.post('/damaged', requirePermission('stock:write'), validate(damagedSchema), asyncHandler(createDamaged))
router.patch(
  '/damaged/:id',
  requirePermission('stock:write'),
  validate(patchMovementSchema),
  asyncHandler(updateDamaged),
)
router.delete(
  '/damaged/:id',
  requirePermission('stock:write'),
  validate(ledgerIdParamsSchema),
  asyncHandler(removeDamaged),
)

router.get('/expired', requirePermission('stock:read'), validate(listLedgerSchema), asyncHandler(listExpired))
router.post('/expired', requirePermission('stock:write'), validate(expiredSchema), asyncHandler(createExpired))
router.patch(
  '/expired/:id',
  requirePermission('stock:write'),
  validate(patchMovementSchema),
  asyncHandler(updateExpired),
)
router.delete(
  '/expired/:id',
  requirePermission('stock:write'),
  validate(ledgerIdParamsSchema),
  asyncHandler(removeExpired),
)

// Phase 5 — Others tab
router.get('/others', requirePermission('stock:read'), validate(listLedgerSchema), asyncHandler(listOthers))
router.post('/others', requirePermission('stock:write'), validate(otherSchema), asyncHandler(createOther))
router.patch(
  '/others/:id',
  requirePermission('stock:write'),
  validate(patchMovementSchema),
  asyncHandler(updateOther),
)
router.delete(
  '/others/:id',
  requirePermission('stock:write'),
  validate(ledgerIdParamsSchema),
  asyncHandler(removeOther),
)

router.get('/transfers', requirePermission('stock:read'), validate(listLedgerSchema), asyncHandler(listStockTransfers))
router.post('/transfers', requirePermission('stock:write'), validate(transferSchema), asyncHandler(createTransfer))

export default router
