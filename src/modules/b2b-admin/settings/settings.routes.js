import { Router } from 'express'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import {
  currencyGet,
  currencyPatch,
  devicesList,
  patchDeviceStatus,
} from './settings.controller.js'
import {
  getCurrencySchema,
  listDevicesQuerySchema,
  updateCurrencySchema,
  updateDeviceStatusSchema,
} from './settings.validator.js'

const router = Router()

router.get('/devices', validate(listDevicesQuerySchema), asyncHandler(devicesList))
router.patch(
  '/devices/:id/status',
  validate(updateDeviceStatusSchema),
  asyncHandler(patchDeviceStatus),
)

router.get('/currency', validate(getCurrencySchema), asyncHandler(currencyGet))
router.patch('/currency', validate(updateCurrencySchema), asyncHandler(currencyPatch))

export default router
