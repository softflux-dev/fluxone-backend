import { z } from 'zod'
import { empty, idParams, optionalString, optionalTime, optionalUuid } from '../shared.validator.js'
import { normalizeWorkingDays, WEEK_DAYS } from '../staff/schedule.validation.js'

const hardwareType = z.enum(['Computers', 'Scanners', 'Printers', 'Telephone', 'Other'])
// Device condition (quality) — distinct from accessStatus active/blocked.
const hardwareStatus = z.enum(['New', 'Used', 'Old', 'Good', 'Poor'])

// Multipart sends strings — coerce empty to undefined
const optionalImageUrl = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.string().max(500).optional(),
)

// workingDays query: "mon,tue" | JSON array string
const optionalWorkingDaysQuery = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined
  const days = normalizeWorkingDays(value)
  return days.length ? days : undefined
}, z.array(z.enum(WEEK_DAYS)).min(1).optional())

const optionalBooleanQuery = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined
  if (value === true || value === 'true' || value === '1') return true
  if (value === false || value === 'false' || value === '0') return false
  return undefined
}, z.boolean().optional())

const staffRoleForHardwareEnum = z.enum([
  'inventory_manager',
  'cashier',
  'production_staff',
  'delivery_staff',
  'website_manager',
])

export const listHardwareSchema = z.object({
  body: empty,
  params: empty,
  query: z.object({
    branchId: optionalUuid,
    type: hardwareType.optional(),
    q: optionalString,
    // Availability window — when set, only return free devices for this slot
    scheduleStart: optionalTime,
    scheduleEnd: optionalTime,
    workingDays: optionalWorkingDaysQuery,
    excludeStaffId: optionalUuid,
    includeBusy: optionalBooleanQuery,
    includeInactive: optionalBooleanQuery,
    forRole: staffRoleForHardwareEnum.optional(),
  }),
})

export const createHardwareSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(120),
    companyName: z.string().trim().max(120).optional().nullable(),
    type: hardwareType,
    status: hardwareStatus.optional().default('New'),
    branchId: optionalUuid,
    assignedToStaffId: optionalUuid,
    imageUrl: optionalImageUrl,
  }),
  query: empty,
  params: empty,
})

export const updateHardwareSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    companyName: z.string().trim().max(120).optional().nullable(),
    type: hardwareType.optional(),
    status: hardwareStatus.optional(),
    // System Access authorize / block
    accessStatus: z.enum(['active', 'blocked']).optional(),
    branchId: optionalUuid,
    assignedToStaffId: optionalUuid,
    imageUrl: optionalImageUrl,
  }),
  query: empty,
  params: idParams,
})

export const hardwareIdParamsSchema = z.object({
  body: empty,
  query: z.object({ branchId: optionalUuid }),
  params: idParams,
})

export const listItemScalesSchema = z.object({
  body: empty,
  params: empty,
  query: z.object({
    q: optionalString,
  }),
})

export const createItemScaleSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(120),
    code: optionalString,
  }),
  query: empty,
  params: empty,
})

export const updateItemScaleSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    code: optionalString,
  }),
  query: empty,
  params: idParams,
})

export const itemScaleIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})
