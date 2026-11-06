import { Router } from 'express'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import { upload } from '../../../middlewares/upload.middleware.js'
import { companyDetail, patchCompany } from './company.controller.js'
import { getCompanySchema, updateCompanySchema } from './company.validator.js'

const companyMedia = upload.fields([{ name: 'logo', maxCount: 1 }])

const router = Router()

router.get('/', validate(getCompanySchema), asyncHandler(companyDetail))
router.patch('/', companyMedia, validate(updateCompanySchema), asyncHandler(patchCompany))

export default router
