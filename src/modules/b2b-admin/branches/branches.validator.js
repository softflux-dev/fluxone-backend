import { z } from 'zod'
import { empty, timeString } from '../../branch-manager/shared.validator.js'
import { BRANCH_STATUS } from '../../../config/constants.js'
import { looseUuidWithMessage } from '../../../utils/zodFields.util.js'

const looseUuid = looseUuidWithMessage('Invalid branch id')

const optionalString = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.string().optional(),
)

// Align with client validatePhone (admin Add Branch form).
function isValidPhone(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[\s()-]/g, '')
  if (!cleaned) return false
  if (/[a-zA-Z]/.test(cleaned)) return false
  if (cleaned.startsWith('+92')) return cleaned.slice(3).length === 10
  if (cleaned.startsWith('03')) return cleaned.length === 11
  if (cleaned.startsWith('+')) return cleaned.length >= 9 && cleaned.length <= 16
  const digits = cleaned.replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 15
}

const phoneString = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .refine(isValidPhone, { message: 'Invalid phone number' })

const optionalPhone = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  phoneString.optional(),
)

// Empty string / null clears hours; omit (undefined) leaves existing value on patch.
const branchHourTime = z.preprocess((value) => {
  if (value === undefined) return undefined
  if (value === '' || value === null) return null
  return value
}, z.union([timeString, z.null()]).optional())

// Branch calendar days — same tokens as staff.working_days
const WEEK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

// Accepts: ["mon","tue"] | '["mon","tue"]' | "mon,tue" | omit (DB default = full week)
const workingDaysSchema = z.preprocess(
  (value) => {
    if (value === undefined || value === null || value === '') return undefined
    if (Array.isArray(value)) {
      return value.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
    }
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (!trimmed) return undefined
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) {
          return parsed.map((d) => String(d).trim().toLowerCase()).filter(Boolean)
        }
      } catch {
        // comma-separated fallback for form-data
      }
      return trimmed
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean)
    }
    return value
  },
  z
    .array(z.enum(WEEK_DAYS))
    .min(1, 'Select at least one working day')
    .refine((days) => new Set(days).size === days.length, {
      message: 'Duplicate working days are not allowed',
    })
    .optional(),
)

const genderSchema = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.enum(['Male', 'Female', 'Other']).optional(),
)

const managerCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(190),
  contact: phoneString,
  otherContact: optionalPhone,
  gender: genderSchema,
  address: optionalString,
  profileImage: optionalString,
  imageUrl: optionalString,
})

const managerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().max(190).optional(),
  contact: optionalPhone,
  otherContact: optionalPhone,
  gender: genderSchema,
  address: optionalString,
  profileImage: optionalString,
  imageUrl: optionalString,
})

function parseTimeToMinutes(value) {
  if (value == null || value === '') return null
  const text = String(value).trim()
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function hasValue(value) {
  return value != null && String(value).trim() !== ''
}

// Both empty OK; both set requires open < close (Phase 1: no overnight).
function refineBranchHours(body, ctx) {
  const hasOpen = hasValue(body.openingTime)
  const hasClose = hasValue(body.closingTime)

  if (hasOpen !== hasClose) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Set both opening and closing time, or leave both empty',
      path: ['body', hasOpen ? 'closingTime' : 'openingTime'],
    })
    return
  }

  if (!hasOpen) return

  const open = parseTimeToMinutes(body.openingTime)
  const close = parseTimeToMinutes(body.closingTime)
  if (open == null || close == null) return
  if (open >= close) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Closing time must be after opening time',
      path: ['body', 'closingTime'],
    })
  }
}

function refineCreateManager(body, ctx) {
  if (body.manager) return

  if (!hasValue(body.managerName)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Branch manager name is required',
      path: ['body', 'managerName'],
    })
  }
  if (!hasValue(body.managerEmail)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Branch manager email is required',
      path: ['body', 'managerEmail'],
    })
  } else if (!z.string().email().safeParse(String(body.managerEmail).trim()).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid manager email',
      path: ['body', 'managerEmail'],
    })
  }
  if (!hasValue(body.managerContact)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Branch manager contact phone is required',
      path: ['body', 'managerContact'],
    })
  } else if (!isValidPhone(body.managerContact)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid phone number',
      path: ['body', 'managerContact'],
    })
  }
  if (hasValue(body.managerOtherContact) && !isValidPhone(body.managerOtherContact)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Invalid phone number',
      path: ['body', 'managerOtherContact'],
    })
  }
}

export const listBranchesQuerySchema = z.object({
  body: empty,
  params: empty,
  query: z.object({
    q: optionalString,
    status: z.enum([BRANCH_STATUS.OPEN, BRANCH_STATUS.BLOCKED]).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
})

export const branchIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: z.object({
    id: looseUuid,
  }),
})

export const createBranchSchema = z
  .object({
    body: z.object({
      name: z.string().trim().min(1).max(160),
      location: z.string().trim().min(1).max(255),
      image: optionalString,
      imageUrl: optionalString,
      status: z.enum([BRANCH_STATUS.OPEN, BRANCH_STATUS.BLOCKED]).optional(),
      openingTime: branchHourTime,
      closingTime: branchHourTime,
      workingDays: workingDaysSchema,
      // Nested manager, or flat manager* fields accepted in controller normalize.
      manager: managerCreateSchema.optional(),
      managerName: optionalString,
      managerEmail: optionalString,
      managerContact: optionalPhone,
      managerOtherContact: optionalPhone,
      managerGender: genderSchema,
      managerAddress: optionalString,
      profileImage: optionalString,
      managerProfileImage: optionalString,
    }),
    query: empty,
    params: empty,
  })
  .superRefine(({ body }, ctx) => {
    refineBranchHours(body, ctx)
    refineCreateManager(body, ctx)
  })

export const updateBranchSchema = z
  .object({
    body: z.object({
      name: z.string().trim().min(1).max(160).optional(),
      location: z.string().trim().min(1).max(255).optional(),
      image: optionalString,
      imageUrl: optionalString,
      openingTime: branchHourTime,
      closingTime: branchHourTime,
      workingDays: workingDaysSchema,
      manager: managerUpdateSchema.optional(),
      managerName: optionalString,
      managerEmail: z.preprocess(
        (value) => (value === '' || value === null || value === undefined ? undefined : value),
        z.string().trim().email().max(190).optional(),
      ),
      managerContact: optionalPhone,
      managerOtherContact: optionalPhone,
      managerGender: genderSchema,
      managerAddress: optionalString,
      profileImage: optionalString,
      managerProfileImage: optionalString,
    }),
    query: empty,
    params: z.object({
      id: looseUuid,
    }),
  })
  .superRefine(({ body }, ctx) => {
    // Only validate the pair when either hour field is present in the patch.
    if (body.openingTime !== undefined || body.closingTime !== undefined) {
      refineBranchHours(body, ctx)
    }
  })

export const branchStatusSchema = z.object({
  body: z.object({
    status: z.enum([BRANCH_STATUS.OPEN, BRANCH_STATUS.BLOCKED]),
  }),
  query: empty,
  params: z.object({
    id: looseUuid,
  }),
})

export const resetPasswordSchema = z.object({
  body: z
    .object({
      // Optional override for testing; otherwise server auto-generates.
      password: z.string().min(8).max(72).optional(),
    })
    .optional()
    .default({}),
  query: empty,
  params: z.object({
    id: looseUuid,
  }),
})
