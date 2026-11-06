import { Router } from 'express'
import { overview } from './dashboard.controller.js'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import { adminDashboardQuerySchema } from './dashboard.validator.js'

const router = Router()

router.get('/', validate(adminDashboardQuerySchema), asyncHandler(overview))

export default router
