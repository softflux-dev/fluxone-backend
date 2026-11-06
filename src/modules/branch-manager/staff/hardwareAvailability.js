import { HARDWARE_MODES, isExclusiveHardwareMode } from './hardwarePolicy.js'
import { normalizeWorkingDays, timesOverlap } from './schedule.validation.js'

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

export function minutesToTimeLabel(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function mergeIntervals(intervals) {
  const sorted = [...intervals]
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start)
  const out = []
  for (const cur of sorted) {
    const last = out[out.length - 1]
    if (!last || cur.start >= last.end) {
      out.push({ start: cur.start, end: cur.end })
    } else if (cur.end > last.end) {
      last.end = cur.end
    }
  }
  return out
}

function subtractInterval(window, occupied) {
  const { start: w0, end: w1 } = window
  const { start: o0, end: o1 } = occupied
  if (o1 <= w0 || o0 >= w1) return [window]
  const parts = []
  if (o0 > w0) parts.push({ start: w0, end: Math.min(o0, w1) })
  if (o1 < w1) parts.push({ start: Math.max(o1, w0), end: w1 })
  return parts.filter((p) => p.end > p.start)
}

function subtractMany(window, occupiedList) {
  let free = [window]
  for (const occ of occupiedList) {
    free = free.flatMap((w) => subtractInterval(w, occ))
  }
  return free
}

function intersectIntervalLists(aList, bList) {
  const out = []
  for (const a of aList) {
    for (const b of bList) {
      const start = Math.max(a.start, b.start)
      const end = Math.min(a.end, b.end)
      if (end > start) out.push({ start, end })
    }
  }
  return mergeIntervals(out)
}

function holderAppliesOnDay(holder, day) {
  return normalizeWorkingDays(holder.workingDays).includes(day)
}

function holderTimeRange(holder) {
  const start = holder.startTime ?? holder.scheduleStart
  const end = holder.endTime ?? holder.scheduleEnd
  return { start, end, startMin: parseTimeToMinutes(start), endMin: parseTimeToMinutes(end) }
}

function holderSnapshot(holder) {
  if (!holder) return null
  const range = holderTimeRange(holder)
  return {
    staffId: holder.staffId || null,
    staffName: holder.staffName || null,
    staffRole: holder.staffRole || null,
    workingDays: normalizeWorkingDays(holder.workingDays),
    startTime: range.start || null,
    endTime: range.end || null,
  }
}

// Free slots valid on every employee working day (subtract all day-specific occupiers).
export function computeFreeSlotsForCandidate(candidate, holders) {
  const days = normalizeWorkingDays(candidate.workingDays)
  const shiftStart = parseTimeToMinutes(candidate.scheduleStart)
  const shiftEnd = parseTimeToMinutes(candidate.scheduleEnd)
  if (!days.length || shiftStart == null || shiftEnd == null || shiftStart >= shiftEnd) {
    return {
      freeSlots: [],
      occupiedIntervals: [],
      availability: 'unavailable',
      available: false,
      holder: null,
    }
  }

  const exclusive = holders.find((h) => isExclusiveHardwareMode(h.mode))
  if (exclusive) {
    return {
      freeSlots: [],
      occupiedIntervals: [
        {
          start: minutesToTimeLabel(shiftStart),
          end: minutesToTimeLabel(shiftEnd),
          staffName: exclusive.staffName || 'Inventory Manager',
        },
      ],
      availability: 'locked_exclusive',
      available: false,
      occupiedBy: exclusive.staffName || 'Inventory Manager',
      occupiedSlot: exclusive.slotLabel || null,
      mode: HARDWARE_MODES.EXCLUSIVE,
      holder: holderSnapshot(exclusive),
    }
  }

  const shiftWindow = { start: shiftStart, end: shiftEnd }
  let freeAcrossDays = [{ start: shiftStart, end: shiftEnd }]
  const occupiedIntervals = []
  let primaryHolder = null

  for (const day of days) {
    const dayOccupied = []
    for (const h of holders) {
      if (!holderAppliesOnDay(h, day)) continue
      const { start, end, startMin, endMin } = holderTimeRange(h)
      if (startMin == null || endMin == null) continue
      if (!timesOverlap(candidate.scheduleStart, candidate.scheduleEnd, start, end)) continue
      dayOccupied.push({ start: startMin, end: endMin })
      if (!primaryHolder) primaryHolder = holderSnapshot(h)
      occupiedIntervals.push({
        start: minutesToTimeLabel(Math.max(shiftStart, startMin)),
        end: minutesToTimeLabel(Math.min(shiftEnd, endMin)),
        staffName: h.staffName,
        day,
      })
    }
    const merged = mergeIntervals(dayOccupied)
    const dayFree = subtractMany(shiftWindow, merged)
    freeAcrossDays = intersectIntervalLists(freeAcrossDays, dayFree)
  }

  const freeSlots = freeAcrossDays.map((i) => ({
    start: minutesToTimeLabel(i.start),
    end: minutesToTimeLabel(i.end),
  }))

  const seen = new Set()
  const occupiedUnique = occupiedIntervals.filter((o) => {
    const key = `${o.start}|${o.end}|${o.staffName}|${o.day}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  let availability = 'available'
  if (!freeSlots.length) {
    availability = 'fully_occupied'
  } else if (
    !(
      freeSlots.length === 1 &&
      freeSlots[0].start === minutesToTimeLabel(shiftStart) &&
      freeSlots[0].end === minutesToTimeLabel(shiftEnd)
    )
  ) {
    availability = 'partial'
  }

  const available = freeSlots.length > 0
  const occupiedBy = occupiedUnique.map((o) => o.staffName).filter(Boolean).join(', ') || null

  return {
    freeSlots,
    occupiedIntervals: occupiedUnique,
    availability,
    available,
    occupiedBy,
    occupiedSlot: occupiedUnique.length
      ? occupiedUnique.map((o) => `${o.start}–${o.end}`).join(' · ')
      : null,
    mode: availability === 'partial' ? HARDWARE_MODES.SHARED : null,
    holder: primaryHolder,
  }
}

export function slotWithinShift(slotStart, slotEnd, scheduleStart, scheduleEnd) {
  const s0 = parseTimeToMinutes(slotStart)
  const s1 = parseTimeToMinutes(slotEnd)
  const w0 = parseTimeToMinutes(scheduleStart)
  const w1 = parseTimeToMinutes(scheduleEnd)
  if (s0 == null || s1 == null || w0 == null || w1 == null) return false
  return s0 >= w0 && s1 <= w1 && s1 > s0
}

export function assertSlotInFreeList(freeSlots, slotStart, slotEnd) {
  const normalize = (value) => {
    const text = String(value || '').trim()
    return text.length >= 5 ? text.slice(0, 5) : text
  }
  const wantStart = normalize(slotStart)
  const wantEnd = normalize(slotEnd)
  return freeSlots.some(
    (s) => normalize(s.start) === wantStart && normalize(s.end) === wantEnd,
  )
}
