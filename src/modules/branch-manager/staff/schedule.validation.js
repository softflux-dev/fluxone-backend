import { z } from 'zod'

// Shift + break + working-day helpers for staff / hardware availability.

export const WEEK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

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

function formatMinutesLabel(minutes) {
  let hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  const period = hours >= 12 ? 'PM' : 'AM'
  hours %= 12
  if (hours === 0) hours = 12
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')} ${period}`
}

// Normalize to unique lowercase day tokens (invalid tokens dropped).
export function normalizeWorkingDays(value) {
  if (value == null) return []
  let raw = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    try {
      const parsed = JSON.parse(trimmed)
      raw = Array.isArray(parsed) ? parsed : trimmed.split(',')
    } catch {
      raw = trimmed.split(',')
    }
  }
  if (!Array.isArray(raw)) return []
  const allowed = new Set(WEEK_DAYS)
  const out = []
  const seen = new Set()
  for (const item of raw) {
    const day = String(item).trim().toLowerCase()
    if (!allowed.has(day) || seen.has(day)) continue
    seen.add(day)
    out.push(day)
  }
  return out
}

export function daysOverlap(a, b) {
  const setB = new Set(normalizeWorkingDays(b))
  return normalizeWorkingDays(a).some((d) => setB.has(d))
}

// True when staff days are all within branch calendar.
export function isSubsetOfDays(staffDays, branchDays) {
  const branch = new Set(normalizeWorkingDays(branchDays))
  if (!branch.size) return true
  return normalizeWorkingDays(staffDays).every((d) => branch.has(d))
}

// Half-open style: [start, end) overlap — equal edges do not conflict.
export function timesOverlap(startA, endA, startB, endB) {
  const a0 = parseTimeToMinutes(startA)
  const a1 = parseTimeToMinutes(endA)
  const b0 = parseTimeToMinutes(startB)
  const b1 = parseTimeToMinutes(endB)
  if (a0 == null || a1 == null || b0 == null || b1 == null) return false
  return a0 < b1 && b0 < a1
}

// Hardware conflict when same device, shared working day, and overlapping shifts.
export function schedulesConflict(a, b) {
  if (!daysOverlap(a?.workingDays, b?.workingDays)) return false
  const aHas = hasValue(a?.scheduleStart) && hasValue(a?.scheduleEnd)
  const bHas = hasValue(b?.scheduleStart) && hasValue(b?.scheduleEnd)
  // Missing shift on either side → treat as full-day conflict on shared days
  if (!aHas || !bHas) return true
  return timesOverlap(a.scheduleStart, a.scheduleEnd, b.scheduleStart, b.scheduleEnd)
}

export function formatAllocatedSlot(schedule) {
  const days = normalizeWorkingDays(schedule?.workingDays)
  const start = parseTimeToMinutes(schedule?.scheduleStart)
  const end = parseTimeToMinutes(schedule?.scheduleEnd)
  if (!days.length && start == null) return null
  const dayLabel = days.length
    ? days.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')
    : null
  const timeLabel =
    start != null && end != null
      ? `${formatMinutesLabel(start)} – ${formatMinutesLabel(end)}`
      : null
  if (timeLabel && dayLabel) return `${timeLabel} · ${dayLabel}`
  return timeLabel || dayLabel
}

// When branch hours exist, shift must sit inside the open→close window.
// If hours are unset, allow the shift (soft policy — admin can set hours later).
export function validateShiftAgainstBranchHours(schedule, branchHours) {
  const openingTime = branchHours?.openingTime
  const closingTime = branchHours?.closingTime
  if (!hasValue(openingTime) || !hasValue(closingTime)) return null

  const hasStart = hasValue(schedule?.scheduleStart)
  const hasEnd = hasValue(schedule?.scheduleEnd)
  if (!hasStart || !hasEnd) return null

  const start = parseTimeToMinutes(schedule.scheduleStart)
  const end = parseTimeToMinutes(schedule.scheduleEnd)
  const open = parseTimeToMinutes(openingTime)
  const close = parseTimeToMinutes(closingTime)
  if (start == null || end == null || open == null || close == null) return null

  if (start < open || end > close) {
    return `Shift must be within branch hours (${formatMinutesLabel(open)}–${formatMinutesLabel(close)})`
  }
  return null
}

// Staff working days must be a non-empty subset of branch.working_days.
export function validateWorkingDaysAgainstBranch(staffDays, branchHours) {
  const days = normalizeWorkingDays(staffDays)
  if (!days.length) {
    return 'Select at least one working day'
  }
  const branchDays = normalizeWorkingDays(branchHours?.workingDays)
  if (!branchDays.length) return null
  if (!isSubsetOfDays(days, branchDays)) {
    return `Working days must be within branch days (${branchDays.join(', ')})`
  }
  return null
}

// Zod preprocess for staff create/update body.workingDays
export const workingDaysFieldSchema = z.preprocess(
  (value) => {
    if (value === undefined) return undefined
    if (value === null || value === '') return undefined
    const days = normalizeWorkingDays(value)
    return days.length ? days : undefined
  },
  z
    .array(z.enum(WEEK_DAYS))
    .min(1, 'Select at least one working day')
    .optional(),
)

// Append Zod issues when shift/break times are illogical.
export function refineStaffSchedule(body, ctx) {
  const hasStart = hasValue(body.scheduleStart)
  const hasEnd = hasValue(body.scheduleEnd)
  const hasBreakStart = hasValue(body.scheduleBreakStart)
  const hasBreakEnd = hasValue(body.scheduleBreakEnd)

  if (hasStart !== hasEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Set both schedule start and end, or leave both empty',
      path: ['body', 'scheduleEnd'],
    })
    return
  }

  if (hasStart && hasEnd) {
    const start = parseTimeToMinutes(body.scheduleStart)
    const end = parseTimeToMinutes(body.scheduleEnd)
    if (start == null || end == null) return
    if (start >= end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Schedule end must be after start',
        path: ['body', 'scheduleEnd'],
      })
    }
  }

  if (hasBreakStart !== hasBreakEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Set both break start and break end, or leave break empty',
      path: ['body', 'scheduleBreakEnd'],
    })
    return
  }

  if (!hasBreakStart) return

  const start = parseTimeToMinutes(body.scheduleStart)
  const end = parseTimeToMinutes(body.scheduleEnd)
  const breakStart = parseTimeToMinutes(body.scheduleBreakStart)
  const breakEnd = parseTimeToMinutes(body.scheduleBreakEnd)

  if (!hasStart || !hasEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Shift start and end are required when setting a break',
      path: ['body', 'scheduleStart'],
    })
    return
  }

  if (breakStart == null || breakEnd == null) return

  if (breakStart >= breakEnd) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Break end must be after break start',
      path: ['body', 'scheduleBreakEnd'],
    })
  }

  if (breakStart < start || breakEnd > end) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Break must fall within the shift (between start and end)',
      path: ['body', 'scheduleBreakStart'],
    })
  }
}
