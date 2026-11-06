import { z } from 'zod'
import { STAFF_STATUS } from '../../../config/constants.js'
import {
  empty,
  idParams,
  optionalString,
  optionalTime,
  optionalUuid,
  paginationQuery,
} from '../shared.validator.js'
import { refineStaffSchedule, workingDaysFieldSchema } from './schedule.validation.js'

const staffRoleEnum = z.enum([
  'inventory_manager',
  'cashier',
  'production_staff',
  'delivery_staff',
  'website_manager',
])

const hardwareTypeEnum = z.enum([
  'Computers',
  'Scanners',
  'Printers',
  'Telephone',
  'Other',
])

const staffStatusEnum = z
  .enum([
    STAFF_STATUS.ACTIVE,
    STAFF_STATUS.INACTIVE,
    'open',
    'blocked',
  ])
  .transform((value) => {
    if (value === 'open') return STAFF_STATUS.ACTIVE
    if (value === 'blocked') return STAFF_STATUS.INACTIVE
    return value
  })

/** Empty string clears assignment; omit keeps previous on update. */
const optionalHardwareDeviceId = z.preprocess((value) => {
  if (value === '') return null
  if (value === undefined) return undefined
  return value
}, z.string().nullable().optional())

const staffListFilterQuery = {
  q: optionalString,
  designationId: optionalUuid,
  status: staffStatusEnum.optional(),
  branchId: optionalUuid,
  role: staffRoleEnum.optional(),
  // Filter staff by assigned hardware type
  hardwareType: hardwareTypeEnum.optional(),
  type: hardwareTypeEnum.optional(),
}

export const listStaffSchema = z.object({
  body: empty,
  params: empty,
  query: paginationQuery.extend(staffListFilterQuery),
})

// Dedicated export — same filters as list, no page/limit
export const exportStaffSchema = z.object({
  body: empty,
  params: empty,
  query: z.object(staffListFilterQuery),
})

export const createStaffSchema = z
  .object({
    body: z.object({
      fullName: z.string().min(1),
      // Login ID (same field used by /auth/login as `id`).
      email: z.string().min(3).max(190),
      password: z.string().min(8),
      role: staffRoleEnum,
      designationId: optionalUuid,
      designation: optionalString,
      branchId: optionalUuid,
      hardwareDeviceId: optionalHardwareDeviceId,
      phone: optionalString,
      status: staffStatusEnum.optional(),
      scheduleStart: optionalTime,
      // Single break time maps to break start; optional end for ranges.
      scheduleBreakStart: optionalTime,
      scheduleBreakEnd: optionalTime,
      scheduleEnd: optionalTime,
      workingDays: workingDaysFieldSchema,
      hardwareAllocationStart: optionalTime,
      hardwareAllocationEnd: optionalTime,
    }),
    query: empty,
    params: empty,
  })
  .superRefine(({ body }, ctx) => {
    refineStaffSchedule(body, ctx)
    refineCashierHardwareAllocation(body, ctx)
  })

export const updateStaffSchema = z
  .object({
    body: z.object({
      fullName: z.string().min(1).optional(),
      email: z.string().min(3).max(190).optional(),
      phone: optionalString,
      role: staffRoleEnum.optional(),
      designationId: optionalUuid,
      designation: optionalString,
      branchId: optionalUuid,
      hardwareDeviceId: optionalHardwareDeviceId,
      status: staffStatusEnum.optional(),
      scheduleStart: optionalTime,
      scheduleBreakStart: optionalTime,
      scheduleBreakEnd: optionalTime,
      scheduleEnd: optionalTime,
      workingDays: workingDaysFieldSchema,
      hardwareAllocationStart: optionalTime,
      hardwareAllocationEnd: optionalTime,
      password: z.string().min(8).optional(),
    }),
    query: empty,
    params: idParams,
  })
  .superRefine(({ body }, ctx) => {
    refineStaffSchedule(body, ctx)
    refineCashierHardwareAllocation(body, ctx)
  })

// Cashier + device → both allocation bounds required (full shift or partial slot).
function refineCashierHardwareAllocation(body, ctx) {
  const role = body.role
  const hasDevice =
    body.hardwareDeviceId != null && String(body.hardwareDeviceId).trim() !== ''
  if (!hasDevice) return
  if (role !== 'cashier') return

  const hasStart =
    body.hardwareAllocationStart != null &&
    String(body.hardwareAllocationStart).trim() !== ''
  const hasEnd =
    body.hardwareAllocationEnd != null &&
    String(body.hardwareAllocationEnd).trim() !== ''
  if (hasStart && hasEnd) return

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      'Cashier hardware assignment requires hardwareAllocationStart and hardwareAllocationEnd',
    path: ['body', 'hardwareAllocationStart'],
  })
}

export const staffIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})

export const reallocateHardwareSchema = z.object({
  body: z.object({
    hardwareDeviceId: z.string().uuid(),
    hardwareAllocationStart: optionalTime,
    hardwareAllocationEnd: optionalTime,
  }),
  query: empty,
  params: idParams,
})

export const updateStaffStatusSchema = z.object({
  body: z.object({
    status: staffStatusEnum,
  }),
  query: empty,
  params: idParams,
})
