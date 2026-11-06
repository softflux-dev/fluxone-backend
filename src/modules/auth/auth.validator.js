import { z } from 'zod'

// Single login form: id + password only.
// Tenant/company is resolved server-side from the user record.
export const loginSchema = z
  .object({
    body: z.object({
      id: z.string().min(1).optional(),
      email: z.string().optional(),
      password: z.string().min(8).max(72),
    }),
    query: z.object({}).optional(),
    params: z.object({}).optional(),
  })
  .superRefine((data, ctx) => {
    const loginId = (data.body.id || data.body.email || '').trim()
    if (!loginId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'id is required',
        path: ['body', 'id'],
      })
    }
  })

// Body optional — logout resolves the session from Authorization Bearer.
export const logoutSchema = z.object({
  body: z
    .object({
      sessionId: z.string().uuid().optional(),
    })
    .optional()
    .default({}),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
})

export const changePasswordSchema = z
  .object({
    body: z.object({
      currentPassword: z.string().min(8).max(72),
      newPassword: z.string().min(8).max(72),
    }),
    query: z.object({}).optional(),
    params: z.object({}).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.body.currentPassword === data.body.newPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'New password must be different from current password',
        path: ['body', 'newPassword'],
      })
    }
  })

// Self-service profile: name + login ID; optional password (requires currentPassword).
// Image-only updates are allowed (multer file checked in controller).
export const updateProfileSchema = z
  .object({
    body: z.object({
      name: z.string().min(1).max(120).optional(),
      id: z.string().min(3).max(190).optional(),
      password: z.string().min(8).max(72).optional(),
      currentPassword: z.string().min(8).max(72).optional(),
    }),
    query: z.object({}).optional(),
    params: z.object({}).optional(),
  })
  .superRefine((data, ctx) => {
    const { password, currentPassword } = data.body
    if (password && !currentPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Current password is required to set a new password',
        path: ['body', 'currentPassword'],
      })
    }
    if (password && currentPassword && password === currentPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'New password must be different from current password',
        path: ['body', 'password'],
      })
    }
  })
export const forgotPasswordSchema = z.object({
  body: z.object({
    id: z.string().trim().min(1, 'User ID is required'),
  }),
})

export const verifyOtpSchema = z.object({
  body: z.object({
    id: z.string().trim().min(1, 'User ID is required'),
    otp: z.string().trim().regex(/^\d{6}$/, 'OTP must be 6 digits'),
  }),
})

export const resetPasswordSchema = z.object({
  body: z
    .object({
      resetToken: z.string().min(1, 'Reset session is missing'),
      // ⚠ newPassword: yahan changePassword wala rule copy karo (min 8 sirf placeholder hai)
      newPassword: z.string().min(8, 'Password must be at least 8 characters'),
      confirmPassword: z.string().min(1, 'Please confirm your password'),
    })
    .refine((d) => d.newPassword === d.confirmPassword, {
      message: 'Passwords do not match',
      path: ['confirmPassword'],
    }),
})