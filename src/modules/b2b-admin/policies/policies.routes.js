import { Router } from 'express'
import { asyncHandler } from '../../../middlewares/error.middleware.js'
import { validate } from '../../../middlewares/validate.middleware.js'
import {
  createPolicyHandler,
  policiesList,
  patchPolicy,
  policyDetail,
  removePolicy,
} from './policies.controller.js'
import {
  createPolicySchema,
  listPoliciesQuerySchema,
  policyIdParamsSchema,
  updatePolicySchema,
} from './policies.validator.js'

const router = Router()

router.get('/', validate(listPoliciesQuerySchema), asyncHandler(policiesList))
router.get('/:id', validate(policyIdParamsSchema), asyncHandler(policyDetail))
router.post('/', validate(createPolicySchema), asyncHandler(createPolicyHandler))
router.patch('/:id', validate(updatePolicySchema), asyncHandler(patchPolicy))
router.delete('/:id', validate(policyIdParamsSchema), asyncHandler(removePolicy))

export default router
