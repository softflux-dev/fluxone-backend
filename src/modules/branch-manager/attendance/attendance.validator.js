import { z } from 'zod'
import { empty } from '../shared.validator.js'

export const listAttendanceSchema = z.object({
  body: empty,
  query: empty,
  params: empty,
})

export const attendanceSchema = z.object({
  body: z.object({
    staffId: z.string().uuid(),
    workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
    status: z.enum(['present', 'absent', 'late', 'holiday', 'leave']),
    note: z.string().max(500).optional(),
  }),
  query: empty,
  params: empty,
})
