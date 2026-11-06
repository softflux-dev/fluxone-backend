import { Router } from 'express'
import dashboardRoutes from './dashboard/dashboard.routes.js'
import staffRoutes from './staff/staff.routes.js'
import designationRoutes from './designations/designation.routes.js'
import activityLogsRoutes from './activity-logs/activity_logs.routes.js'
import { attendanceList, markAttendance } from './attendance/attendance.controller.js'
import {
  listScales,
  saveScale,
  getStaffScores,
  postEvaluation,
  getEmployeeDetail,
} from './performance/performance.controller.js'
import { holidaysList, addHoliday, editHoliday, removeHoliday } from './holidays/holidays.controller.js'
import {
  leavesList,
  addLeave,
  editLeave,
  removeLeave,
  myLeavesList,
  addMyLeave,
  editMyLeave,
  removeMyLeave,
} from './leaves/leaves.controller.js'
import {
  createStaffLeaveSchema,
  createMyLeaveSchema,
  updateStaffLeaveSchema,
  updateMyLeaveSchema,
  listStaffLeavesSchema,
  leaveIdParamsSchema,
} from './leaves/leaves.validator.js'
import { salesList, processRefund } from './sales/sales.controller.js'
import { getDiscounts, addDiscount, editDiscount, removeDiscount } from './discounts/discounts.controller.js'
import { addStockRequest, stockRequestList } from './stock/stock_request.controller.js'
import {
  getBranchStockPriceRule,
  patchBranchStockPriceRule,
} from '../inventory-manager/control/control.controller.js'
import {
  branchPriceRulePatchSchema,
  priceRuleSchema,
} from '../inventory-manager/control/control.validator.js'
import {
  hardwareList,
  hardwareCreate,
  hardwareUpdate,
  hardwareRemove,
  scalesList,
  scalesCreate,
  scalesUpdate,
  scalesRemove,
} from './resources/resources.controller.js'
import {
  variantTypesList,
  variantTypesGet,
  variantTypesCreate,
  variantTypesUpdate,
  variantTypesRemove,
  variantValuesList,
  variantValuesGet,
  variantValuesCreate,
  variantValuesUpdate,
  variantValuesRemove,
} from './resources/variants.controller.js'
import {
  listVariantTypesSchema,
  createVariantTypeSchema,
  updateVariantTypeSchema,
  variantTypeIdParamsSchema,
  listVariantValuesSchema,
  createVariantValueSchema,
  updateVariantValueSchema,
  variantValueIdParamsSchema,
} from './resources/variants.validator.js'
import { asyncHandler } from '../../middlewares/error.middleware.js'
import { requirePermission } from '../../middlewares/role.middleware.js'
import { validate } from '../../middlewares/validate.middleware.js'
import { upload } from '../../middlewares/upload.middleware.js'
import { attendanceSchema, listAttendanceSchema } from './attendance/attendance.validator.js'
import { createStockRequestSchema, listStockRequestsSchema } from './stock/stock_request.validator.js'
import {
  listHolidaysSchema,
  createHolidaySchema,
  updateHolidaySchema,
  holidayIdParamsSchema,
} from './holidays/holidays.validator.js'
import { listSalesSchema, refundSaleSchema } from './sales/sales.validator.js'
import {
  listDiscountsSchema,
  createDiscountSchema,
  updateDiscountSchema,
  discountIdParamsSchema,
} from './discounts/discounts.validator.js'
import {
  listScalesSchema,
  listScoresSchema,
  saveScaleSchema,
  createEvaluationSchema,
  employeeDetailSchema,
} from './performance/performance.validator.js'
import {
  listHardwareSchema,
  createHardwareSchema,
  updateHardwareSchema,
  hardwareIdParamsSchema,
  listItemScalesSchema,
  createItemScaleSchema,
  updateItemScaleSchema,
  itemScaleIdParamsSchema,
} from './resources/resources.validator.js'

const router = Router()

// Sub-routes
router.use('/dashboard', dashboardRoutes)
router.use('/staff', staffRoutes)
router.use('/designations', designationRoutes)
router.use('/activity-logs', activityLogsRoutes)

// Attendance
router.get(
  '/attendance',
  requirePermission('attendance:write'),
  validate(listAttendanceSchema),
  asyncHandler(attendanceList),
)
router.post(
  '/attendance',
  requirePermission('attendance:write'),
  validate(attendanceSchema),
  asyncHandler(markAttendance),
)

// Holidays
router.get(
  '/holidays',
  requirePermission('staff:read'),
  validate(listHolidaysSchema),
  asyncHandler(holidaysList),
)
router.post(
  '/holidays',
  requirePermission('staff:write'),
  validate(createHolidaySchema),
  asyncHandler(addHoliday),
)
router.put(
  '/holidays/:id',
  requirePermission('staff:write'),
  validate(updateHolidaySchema),
  asyncHandler(editHoliday),
)
router.delete(
  '/holidays/:id',
  requirePermission('staff:write'),
  validate(holidayIdParamsSchema),
  asyncHandler(removeHoliday),
)

// Leaves — My Leave (BM self) must be registered before /leaves/:id
router.get('/leaves/me', requirePermission('staff:read'), asyncHandler(myLeavesList))
router.post(
  '/leaves/me',
  requirePermission('staff:write'),
  validate(createMyLeaveSchema),
  asyncHandler(addMyLeave),
)
router.put(
  '/leaves/me/:id',
  requirePermission('staff:write'),
  validate(updateMyLeaveSchema),
  asyncHandler(editMyLeave),
)
router.delete(
  '/leaves/me/:id',
  requirePermission('staff:write'),
  validate(leaveIdParamsSchema),
  asyncHandler(removeMyLeave),
)

// Leaves — Staff Leave (BM appoints employees)
router.get(
  '/leaves',
  requirePermission('staff:read'),
  validate(listStaffLeavesSchema),
  asyncHandler(leavesList),
)
router.post(
  '/leaves',
  requirePermission('staff:write'),
  validate(createStaffLeaveSchema),
  asyncHandler(addLeave),
)
router.put(
  '/leaves/:id',
  requirePermission('staff:write'),
  validate(updateStaffLeaveSchema),
  asyncHandler(editLeave),
)
router.delete(
  '/leaves/:id',
  requirePermission('staff:write'),
  validate(leaveIdParamsSchema),
  asyncHandler(removeLeave),
)

// Sales
router.get(
  '/sales',
  requirePermission('branch-dashboard:read'),
  validate(listSalesSchema),
  asyncHandler(salesList),
)
router.post(
  '/sales/:id/refund',
  requirePermission('staff:write'),
  validate(refundSaleSchema),
  asyncHandler(processRefund),
)

// Performance Scoring & Scales (versioned) + evaluations
router.get(
  '/performance/scales',
  requirePermission('performance:read'),
  validate(listScalesSchema),
  asyncHandler(listScales),
)
router.put(
  '/performance/scales',
  requirePermission('staff:write'),
  validate(saveScaleSchema),
  asyncHandler(saveScale),
)
router.get(
  '/performance/scores',
  requirePermission('performance:read'),
  validate(listScoresSchema),
  asyncHandler(getStaffScores),
)
router.post(
  '/performance/evaluations',
  requirePermission('staff:write'),
  validate(createEvaluationSchema),
  asyncHandler(postEvaluation),
)
router.get(
  '/performance/employees/:staffId',
  requirePermission('performance:read'),
  validate(employeeDetailSchema),
  asyncHandler(getEmployeeDetail),
)

// Discounts
router.get(
  '/discounts',
  requirePermission('items:read'),
  validate(listDiscountsSchema),
  asyncHandler(getDiscounts),
)
router.post(
  '/discounts',
  requirePermission('items:write'),
  validate(createDiscountSchema),
  asyncHandler(addDiscount),
)
router.put(
  '/discounts/:id',
  requirePermission('items:write'),
  validate(updateDiscountSchema),
  asyncHandler(editDiscount),
)
router.delete(
  '/discounts/:id',
  requirePermission('items:write'),
  validate(discountIdParamsSchema),
  asyncHandler(removeDiscount),
)

// Resources — POS hardware + item scales
router.get(
  '/resources/hardware',
  requirePermission('resources:read'),
  validate(listHardwareSchema),
  asyncHandler(hardwareList),
)
router.post(
  '/resources/hardware',
  requirePermission('resources:write'),
  upload.single('image'),
  validate(createHardwareSchema),
  asyncHandler(hardwareCreate),
)
router.put(
  '/resources/hardware/:id',
  requirePermission('resources:write'),
  upload.single('image'),
  validate(updateHardwareSchema),
  asyncHandler(hardwareUpdate),
)
router.delete(
  '/resources/hardware/:id',
  requirePermission('resources:write'),
  validate(hardwareIdParamsSchema),
  asyncHandler(hardwareRemove),
)
router.get(
  '/resources/scales',
  requirePermission('resources:read'),
  validate(listItemScalesSchema),
  asyncHandler(scalesList),
)
router.post(
  '/resources/scales',
  requirePermission('resources:write'),
  validate(createItemScaleSchema),
  asyncHandler(scalesCreate),
)
router.put(
  '/resources/scales/:id',
  requirePermission('resources:write'),
  validate(updateItemScaleSchema),
  asyncHandler(scalesUpdate),
)
router.delete(
  '/resources/scales/:id',
  requirePermission('resources:write'),
  validate(itemScaleIdParamsSchema),
  asyncHandler(scalesRemove),
)
// Resources — Variant Types & Values (parallel to item_scales)
router.get(
  '/resources/variant-types',
  requirePermission('resources:read'),
  validate(listVariantTypesSchema),
  asyncHandler(variantTypesList),
)
router.get(
  '/resources/variant-types/:id',
  requirePermission('resources:read'),
  validate(variantTypeIdParamsSchema),
  asyncHandler(variantTypesGet),
)
router.post(
  '/resources/variant-types',
  requirePermission('resources:write'),
  validate(createVariantTypeSchema),
  asyncHandler(variantTypesCreate),
)
router.put(
  '/resources/variant-types/:id',
  requirePermission('resources:write'),
  validate(updateVariantTypeSchema),
  asyncHandler(variantTypesUpdate),
)
router.delete(
  '/resources/variant-types/:id',
  requirePermission('resources:write'),
  validate(variantTypeIdParamsSchema),
  asyncHandler(variantTypesRemove),
)
router.get(
  '/resources/variant-values',
  requirePermission('resources:read'),
  validate(listVariantValuesSchema),
  asyncHandler(variantValuesList),
)
router.get(
  '/resources/variant-values/:id',
  requirePermission('resources:read'),
  validate(variantValueIdParamsSchema),
  asyncHandler(variantValuesGet),
)
router.post(
  '/resources/variant-values',
  requirePermission('resources:write'),
  validate(createVariantValueSchema),
  asyncHandler(variantValuesCreate),
)
router.put(
  '/resources/variant-values/:id',
  requirePermission('resources:write'),
  validate(updateVariantValueSchema),
  asyncHandler(variantValuesUpdate),
)
router.delete(
  '/resources/variant-values/:id',
  requirePermission('resources:write'),
  validate(variantValueIdParamsSchema),
  asyncHandler(variantValuesRemove),
)

// Stock Control Price — BM Inventory Monitoring toggle.
router.get(
  '/inventory/price-rule',
  requirePermission('items:read'),
  validate(priceRuleSchema),
  asyncHandler(getBranchStockPriceRule),
)
router.patch(
  '/inventory/price-rule',
  requirePermission('items:write'),
  validate(branchPriceRulePatchSchema),
  asyncHandler(patchBranchStockPriceRule),
)

// Stock Requests
router.get(
  '/stock-requests',
  requirePermission('stock:read'),
  validate(listStockRequestsSchema),
  asyncHandler(stockRequestList),
)
router.post(
  '/stock-requests',
  requirePermission('stock-requests:write'),
  validate(createStockRequestSchema),
  asyncHandler(addStockRequest),
)

export default router
