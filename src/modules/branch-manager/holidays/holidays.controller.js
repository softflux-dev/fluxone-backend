import {
  createHolidaySchedule,
  listHolidaySchedules,
  getHolidayScheduleById,
  updateHolidaySchedule,
  deleteHolidaySchedule,
} from './holidays.model.js'
import {
  clearHolidayAttendanceByDates,
  batchUpsertHolidayAttendance,
} from '../attendance/attendance.model.js'
import {
  notifyAdminsOfHoliday,
  notifyBranchUsersOfHoliday,
} from '../../notifications/notifications.service.js'
import { resolveListBranchId } from '../staff/staff.access.js'
import { tenantQuery } from '../../../config/db.js'
import { success, fail, failFromError } from '../../../utils/response.util.js'

function getDatesInRange(startDate, endDate) {
  const dates = []
  if (!startDate) return dates
  const current = new Date(startDate)
  const last = new Date(endDate || startDate)
  if (Number.isNaN(current.getTime()) || Number.isNaN(last.getTime())) return dates
  // Normalize to UTC date-only to avoid timezone day-shift
  const cursor = new Date(Date.UTC(current.getFullYear(), current.getMonth(), current.getDate()))
  const end = new Date(Date.UTC(last.getFullYear(), last.getMonth(), last.getDate()))
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

// BM locked to JWT branch; admin may see all when no explicit filter
function requireBranchId(req) {
  try {
    return resolveListBranchId(req, null)
  } catch (err) {
    err.status = err.status || 403
    throw err
  }
}

// Holiday rows are branch-owned — BM cannot touch another branch's schedule
function assertHolidayBranchAccess(schedule, branchId) {
  if (!schedule) return null
  // Admin (branchId null) may manage any tenant holiday
  if (!branchId) return schedule
  if (!schedule.branchId || schedule.branchId !== branchId) {
    const err = new Error('Holiday schedule not found')
    err.status = 404
    throw err
  }
  return schedule
}

// Only staff belonging to this branch may be assigned to a holiday
async function assertStaffIdsInBranch(tenantId, branchId, employeeIds) {
  const ids = [...new Set((Array.isArray(employeeIds) ? employeeIds : []).filter(Boolean))]
  if (!ids.length) return ids
  if (!branchId) {
    const err = new Error('branchId is required to assign staff')
    err.status = 400
    throw err
  }

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT s.id
      FROM staff s
      WHERE s.tenant_id = $1
        AND s.branch_id = $2
        AND s.id = ANY($3::uuid[])
    `,
    [branchId, ids],
  )

  if (rows.length !== ids.length) {
    const err = new Error('One or more selected staff do not belong to this branch')
    err.status = 400
    throw err
  }
  return ids
}

async function resolveTargetStaffIds(tenantId, schedule, employeeIds) {
  const branchId = schedule.branchId || null
  if (!branchId) return []

  if (schedule.isAllEmployees) {
    const { rows: allStaff } = await tenantQuery(
      tenantId,
      `
        SELECT s.id
        FROM staff s
        JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
        WHERE s.tenant_id = $1
          AND s.status = 'active'
          AND u.is_active = true
          AND s.branch_id = $2
      `,
      [branchId],
    )
    return allStaff.map((s) => s.id)
  }
  return assertStaffIdsInBranch(tenantId, branchId, employeeIds)
}

//
// Sync holiday → attendance (branch-scoped clear + upsert only).
//
async function syncScheduleAttendance(tenantId, userId, schedule, employeeIds) {
  const dates = getDatesInRange(schedule.startDate, schedule.endDate)
  if (!dates.length) return

  const note = schedule.name || null
  const branchId = schedule.branchId || null
  if (!branchId) return

  if (schedule.status === 'inactive') {
    await clearHolidayAttendanceByDates(tenantId, { dates, note, branchId })
    return
  }

  const targetStaffIds = await resolveTargetStaffIds(tenantId, schedule, employeeIds)
  if (!targetStaffIds.length) {
    // Still clear prior marks for this branch/holiday name on these dates
    await clearHolidayAttendanceByDates(tenantId, { dates, note, branchId })
    return
  }

  // Replace prior marks for this holiday on this branch only, then write fresh rows
  await clearHolidayAttendanceByDates(tenantId, {
    dates,
    note,
    branchId,
    staffIds: targetStaffIds,
  })
  await batchUpsertHolidayAttendance(tenantId, {
    staffIds: targetStaffIds,
    dates,
    note,
    createdBy: userId,
  })
}

export async function holidaysList(req, res) {
  // BM → own branch only; never fall back to null (that leaked all tenant holidays)
  const branchId = requireBranchId(req)
  const rows = await listHolidaySchedules(req.tenantId, { branchId })
  return success(res, rows)
}

export async function addHoliday(req, res) {
  const {
    name,
    startDate,
    endDate,
    isAllEmployees = true,
    employeeIds = [],
    status = 'active',
  } = req.validated.body

  try {
    const branchId = requireBranchId(req)
    if (!branchId) {
      return fail(res, 'Holidays must be created for a specific branch', 400)
    }

    const scopedEmployeeIds = Boolean(isAllEmployees)
      ? []
      : await assertStaffIdsInBranch(req.tenantId, branchId, employeeIds)

    const schedule = await createHolidaySchedule(req.tenantId, {
      name: name.trim(),
      startDate,
      endDate: endDate || startDate,
      isAllEmployees: Boolean(isAllEmployees),
      employeeIds: scopedEmployeeIds,
      status: status || 'active',
      branchId,
    })

    await syncScheduleAttendance(
      req.tenantId,
      req.user.id,
      {
        ...schedule,
        startDate: schedule.startDate,
        endDate: schedule.endDate,
      },
      scopedEmployeeIds,
    )

    // Notify tenant admins + this branch's users (non-blocking)
    try {
      const { rows: ctxRows } = await tenantQuery(
        req.tenantId,
        `
          SELECT
            u.full_name AS "managerName",
            b.name AS "branchName"
          FROM users u
          LEFT JOIN branches b ON b.id = $2 AND b.tenant_id = u.tenant_id
          WHERE u.tenant_id = $1 AND u.id = $3
          LIMIT 1
        `,
        [branchId, req.user.id],
      )
      const ctx = ctxRows[0] || {}
      const notifyCtx = {
        managerName: ctx.managerName || req.user?.name || req.user?.fullName || 'Branch Manager',
        branchName: ctx.branchName || null,
      }
      await notifyAdminsOfHoliday(req.tenantId, schedule, notifyCtx)
      await notifyBranchUsersOfHoliday(req.tenantId, schedule, {
        ...notifyCtx,
        excludeUserId: req.user.id,
      })
    } catch (notifyErr) {
      console.error('[holidays] Failed to notify users:', notifyErr?.message || notifyErr)
    }

    return success(res, schedule, 201)
  } catch (err) {
    return failFromError(res, err, 'Failed to create holiday schedule')
  }
}

export async function editHoliday(req, res) {
  const { id } = req.validated.params
  const {
    name,
    startDate,
    endDate,
    holidayDate,
    isAllEmployees,
    employeeIds,
    status,
  } = req.validated.body

  try {
    const branchId = requireBranchId(req)
    const existing = assertHolidayBranchAccess(
      await getHolidayScheduleById(req.tenantId, id, { branchId }),
      branchId,
    )
    if (!existing) return fail(res, 'Holiday schedule not found', 404)

    const scopedBranchId = existing.branchId || branchId
    const nextAll =
      isAllEmployees !== undefined ? Boolean(isAllEmployees) : existing.isAllEmployees
    const scopedEmployeeIds = nextAll
      ? []
      : await assertStaffIdsInBranch(
          req.tenantId,
          scopedBranchId,
          employeeIds !== undefined ? employeeIds : existing.employeeIds,
        )

    // Clear old marks for THIS branch only before updating dates/name
    const oldDates = getDatesInRange(existing.startDate, existing.endDate)
    if (oldDates.length) {
      await clearHolidayAttendanceByDates(req.tenantId, {
        dates: oldDates,
        note: existing.name,
        branchId: scopedBranchId,
      })
    }

    const updated = await updateHolidaySchedule(req.tenantId, id, {
      name: name?.trim(),
      startDate: startDate || holidayDate || existing.startDate,
      endDate: endDate || startDate || holidayDate || existing.endDate,
      isAllEmployees: nextAll,
      employeeIds: scopedEmployeeIds,
      status,
      branchId: scopedBranchId,
    })

    if (!updated) return fail(res, 'Failed to update holiday schedule', 500)

    await syncScheduleAttendance(
      req.tenantId,
      req.user.id,
      updated,
      updated.employeeIds,
    )

    return success(res, updated)
  } catch (err) {
    return failFromError(res, err, 'Failed to update holiday schedule')
  }
}

export async function removeHoliday(req, res) {
  const { id } = req.validated.params

  try {
    const branchId = requireBranchId(req)
    const existing = assertHolidayBranchAccess(
      await getHolidayScheduleById(req.tenantId, id, { branchId }),
      branchId,
    )
    if (!existing) return fail(res, 'Holiday schedule not found', 404)

    const scopedBranchId = existing.branchId || branchId
    const dates = getDatesInRange(existing.startDate, existing.endDate)
    if (dates.length) {
      await clearHolidayAttendanceByDates(req.tenantId, {
        dates,
        note: existing.name,
        branchId: scopedBranchId,
      })
    }

    const deleted = await deleteHolidaySchedule(req.tenantId, id, { branchId: scopedBranchId })
    return success(res, deleted)
  } catch (err) {
    return failFromError(res, err, 'Failed to delete holiday schedule')
  }
}
