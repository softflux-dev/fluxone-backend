import { Router } from 'express'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import { upload } from '../../../middlewares/upload.middleware.js'
import {
  branchDetail,
  branchesList,
  createBranch,
  patchBranch,
  patchBranchStatus,
  removeBranch,
  resetPassword,
} from './branches.controller.js'
import {
  branchIdParamsSchema,
  branchStatusSchema,
  createBranchSchema,
  listBranchesQuerySchema,
  resetPasswordSchema,
  updateBranchSchema,
} from './branches.validator.js'

const branchMedia = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'profile_image', maxCount: 1 },
])

const router = Router()

router.get('/', validate(listBranchesQuerySchema), asyncHandler(branchesList))
router.get('/:id', validate(branchIdParamsSchema), asyncHandler(branchDetail))
router.post('/', branchMedia, validate(createBranchSchema), asyncHandler(createBranch))
router.patch('/:id', branchMedia, validate(updateBranchSchema), asyncHandler(patchBranch))
router.patch('/:id/status', validate(branchStatusSchema), asyncHandler(patchBranchStatus))
router.post('/:id/reset-password', validate(resetPasswordSchema), asyncHandler(resetPassword))
router.delete('/:id', validate(branchIdParamsSchema), asyncHandler(removeBranch))

export default router
