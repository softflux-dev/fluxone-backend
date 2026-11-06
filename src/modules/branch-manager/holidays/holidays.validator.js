import { z } from 'zod'
import { empty, idParams, optionalUuid } from '../shared.validator.js'

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')

const optionalBool = z.preprocess((value) => {
  if (value === '' || value === null || value === undefined) return undefined
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return value
}, z.boolean().optional())

const holidayStatus = z.enum(['active', 'inactive'])

function withOrderedDates(schema) {
  return schema.superRefine((value, ctx) => {
    const start = value.startDate || value.holidayDate
    const end = value.endDate || start
    if (start && end && start > end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'End date must be on or after start date',
        path: ['endDate'],
      })
    }
  })
}

export const listHolidaysSchema = z.object({
  body: empty,
  query: empty,
  params: empty,
})

export const createHolidaySchema = z.object({
  body: withOrderedDates(
    z.object({
      name: z.string().trim().min(1).max(120),
      startDate: isoDate,
      endDate: isoDate.optional(),
      isAllEmployees: optionalBool.default(true),
      employeeIds: z.array(z.string().uuid()).optional().default([]),
      status: holidayStatus.optional().default('active'),
    }),
  ),
  query: empty,
  params: empty,
})

export const updateHolidaySchema = z.object({
  body: withOrderedDates(
    z.object({
      name: z.string().trim().min(1).max(120).optional(),
      startDate: isoDate.optional(),
      endDate: isoDate.optional(),
      // Legacy alias accepted by older clients
      holidayDate: isoDate.optional(),
      isAllEmployees: optionalBool,
      employeeIds: z.array(z.string().uuid()).optional(),
      status: holidayStatus.optional(),
      branchId: optionalUuid,
    }),
  ),
  query: empty,
  params: idParams,
})

export const holidayIdParamsSchema = z.object({
  body: empty,
  query: empty,
  params: idParams,
})
