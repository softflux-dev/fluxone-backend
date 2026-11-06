import { Router } from 'express'

import {
  changePassword,
  login,
  logout,
  logoutAll,
  me,
  updateMe,
  forgotPassword,
  verifyOtp,
  resetPassword,
} from './auth.controller.js'

import { authMiddleware } from '../../middlewares/auth.middleware.js'
import { asyncHandler } from '../../middlewares/error.middleware.js'
import { upload } from '../../middlewares/upload.middleware.js'
import { validate } from '../../middlewares/validate.middleware.js'
import {
  changePasswordSchema,
  loginSchema,
  logoutSchema,
  updateProfileSchema,
  forgotPasswordSchema,
  verifyOtpSchema,
  resetPasswordSchema,
} from './auth.validator.js'

import {
  forgotPasswordLimiter,
  resetPasswordLimiter,
} from '../../middlewares/rateLimit.middleware.js'
const router = Router()

// Multipart empty strings break zod optional() — treat as omitted
function clearEmptyMultipartFields(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    for (const key of Object.keys(req.body)) {
      if (req.body[key] === '') req.body[key] = undefined
    }
  }
  next()
}

router.post('/login', validate(loginSchema), asyncHandler(login))
router.post('/forgot-password', forgotPasswordLimiter, validate(forgotPasswordSchema), forgotPassword)

router.post('/verify-otp', resetPasswordLimiter, validate(verifyOtpSchema), verifyOtp)

router.post('/reset-password', resetPasswordLimiter, validate(resetPasswordSchema), resetPassword)

// Bearer optional — revoke current opaque session when present.
router.post('/logout', validate(logoutSchema), asyncHandler(logout))
// Explicit logout from all devices.
router.post('/logout-all', authMiddleware, asyncHandler(logoutAll))
router.get('/me', authMiddleware, asyncHandler(me))

router.patch(
  '/me',
  authMiddleware,
  upload.single('image'),
  clearEmptyMultipartFields,
  validate(updateProfileSchema),
  asyncHandler(updateMe),
)
router.post(
  '/change-password',
  authMiddleware,
  validate(changePasswordSchema),
  asyncHandler(changePassword),
)

export default router
