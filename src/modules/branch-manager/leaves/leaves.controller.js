import {
  createStaffLeave,
  createMyLeave,
  listStaffLeaves,
  listMyLeaves,
  getLeaveById,
  findOverlappingLeave,
  updateLeave,
  deleteLeave,
} from './leaves.model.js'
import {
  upsertAttendance,
  clearAttendanceMarks,
} from '../attendance/attendance.model.js'
import { getStaffById } from '../staff/staff.model.js'
import { resolveListBranchId } from '../staff/staff.access.js'
import { notifyAdminsOfLeaveRequest } from '../../notifications/notifications.service.js'
import { tenantQuery } from '../../../config/db.js'
import { success, fail, failFromError } from '../../../utils/response.util.js'

function toIsoDate(value) {
  if (!value) return null
  if (typeof value === 'string') return value.slice(0, 10)
  return new Date(value).toISOString().slice(0, 10)
}

function getDatesInRange(startDate, endDate) {
  const dates = []
  const start = toIsoDate(startDate)
  const end = toIsoDate(endDate)
  if (!start || !end) return dates
  let current = new Date(`${start}T12:00:00.000Z`)
  const last = new Date(`${end}T12:00:00.000Z`)
  while (current <= last) {
    dates.push(current.toISOString().split('T')[0])
    current.setUTCDate(current.getUTCDate() + 1)
  }
  return dates
}

function requireBranchId(req) {
  try {
    return resolveListBranchId(req, null)
  } catch (err) {
    err.status = err.status || 403
    throw err
  }
}

function overlapMessage(existing) {
  const start = toIsoDate(existing?.startDate) || 'that date'
  const end = toIsoDate(existing?.endDate) || start
  const range = start === end ? start : `${start} – ${end}`
  const status = existing?.status === 'pending' ? 'pending' : 'approved'
  return `A ${status} leave already covers ${range}. Same-date leave is not allowed while that request is active.`
}

// ── Staff Leave (BM appoints employees) ─────────────────────────────────────

export async function leavesList(req, res) {
  const branchId = requireBranchId(req)
  const designationId = req.query?.designationId || null
  const rows = await listStaffLeaves(req.tenantId, { branchId, designationId })
  return success(res, rows)
}

export async function addLeave(req, res) {
  const { employeeIds, startDate, endDate, reason } = req.body
  const branchId = requireBranchId(req)

  try {
    const dates = getDatesInRange(startDate, endDate)
    const created = []

    for (const employeeId of employeeIds) {
      // Only staff on this branch (BM cannot appoint self — no staff row)
      const staffRow = await getStaffById(req.tenantId, employeeId, { branchId })
      if (!staffRow) {
        return fail(res, 'One or more employees were not found in this branch', 404)
      }

      // Same-date policy: block if pending/approved leave already overlaps
      const overlap = await findOverlappingLeave(req.tenantId, {
        leaveFor: 'staff',
        staffId: employeeId,
        startDate,
        endDate,
      })
      if (overlap) {
        return fail(res, overlapMessage(overlap), 409)
      }

      const leave = await createStaffLeave(req.tenantId, {
        staffId: employeeId,
        branchId,
        requestedBy: req.user.id,
        startDate,
        endDate,
        reason,
        status: 'approved',
      })
      created.push(leave)

      // Staff leave is final — sync attendance immediately
      for (const date of dates) {
        await upsertAttendance(req.tenantId, {
          staffId: employeeId,
          workDate: date,
          status: 'leave',
          note: reason || 'Leave approved',
          createdBy: req.user.id,
        })
      }
    }

    return success(
      res,
      { message: 'Leave approved and attendance marked successfully', items: created },
      201,
    )
  } catch (err) {
    return failFromError(res, err, 'Failed to create leave')
  }
}

export async function editLeave(req, res) {
  const { id } = req.params
  const { startDate, endDate, reason, status } = req.body
  const branchId = requireBranchId(req)

  try {
    const existing = await getLeaveById(req.tenantId, id)
    if (!existing || existing.leaveFor !== 'staff' || existing.branchId !== branchId) {
      return fail(res, 'Leave not found', 404)
    }

    const nextStart = startDate || existing.startDate
    const nextEnd = endDate || existing.endDate
    const nextReason = reason !== undefined ? reason : existing.reason
    const nextStatus = status || existing.status

    if (nextStatus === 'pending' || nextStatus === 'approved') {
      const overlap = await findOverlappingLeave(req.tenantId, {
        leaveFor: 'staff',
        staffId: existing.staffId,
        startDate: nextStart,
        endDate: nextEnd,
        excludeId: id,
      })
      if (overlap) {
        return fail(res, overlapMessage(overlap), 409)
      }
    }

    const oldDates = getDatesInRange(existing.startDate, existing.endDate)
    await clearAttendanceMarks(req.tenantId, {
      staffId: existing.staffId,
      dates: oldDates,
      status: 'leave',
    })

    const updated = await updateLeave(req.tenantId, id, {
      startDate: nextStart,
      endDate: nextEnd,
      reason: nextReason,
      status: nextStatus,
    })

    if (nextStatus !== 'cancelled' && nextStatus !== 'rejected') {
      const newDates = getDatesInRange(nextStart, nextEnd)
      for (const date of newDates) {
        await upsertAttendance(req.tenantId, {
          staffId: existing.staffId,
          workDate: date,
          status: 'leave',
          note: nextReason || 'Leave approved',
          createdBy: req.user.id,
        })
      }
    }

    return success(res, updated)
  } catch (err) {
    return failFromError(res, err, 'Failed to update leave')
  }
}

export async function removeLeave(req, res) {
  const { id } = req.params
  const branchId = requireBranchId(req)

  try {
    const existing = await getLeaveById(req.tenantId, id)
    if (!existing || existing.leaveFor !== 'staff' || existing.branchId !== branchId) {
      return fail(res, 'Leave not found', 404)
    }

    const dates = getDatesInRange(existing.startDate, existing.endDate)
    await clearAttendanceMarks(req.tenantId, {
      staffId: existing.staffId,
      dates,
      status: 'leave',
    })

    const deleted = await deleteLeave(req.tenantId, id)
    return success(res, deleted)
  } catch (err) {
    return failFromError(res, err, 'Failed to delete leave')
  }
}

// ── My Leave (BM self-request → Admin decides) ──────────────────────────────

export async function myLeavesList(req, res) {
  const branchId = requireBranchId(req)
  const rows = await listMyLeaves(req.tenantId, {
    requestedBy: req.user.id,
    branchId,
  })
  return success(res, rows)
}

export async function addMyLeave(req, res) {
  const { startDate, endDate, reason } = req.body
  const branchId = requireBranchId(req)

  try {
    // Same-date policy: block another request while pending/approved leave overlaps
    const overlap = await findOverlappingLeave(req.tenantId, {
      leaveFor: 'branch_manager',
      requestedBy: req.user.id,
      startDate,
      endDate,
    })
    if (overlap) {
      return fail(res, overlapMessage(overlap), 409)
    }

    const leave = await createMyLeave(req.tenantId, {
      branchId,
      requestedBy: req.user.id,
      startDate,
      endDate,
      reason,
    })

    // Notify tenant admins (non-blocking for response if notify fails)
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
      await notifyAdminsOfLeaveRequest(req.tenantId, leave, {
        managerName: ctx.managerName || req.user.name || 'Branch Manager',
        branchName: ctx.branchName || null,
      })
    } catch (notifyErr) {
      console.error('[leaves] Failed to notify admins:', notifyErr?.message || notifyErr)
    }

    return success(
      res,
      { message: 'Leave request submitted for Admin approval', leave },
      201,
    )
  } catch (err) {
    return failFromError(res, err, 'Failed to submit leave request')
  }
}

export async function editMyLeave(req, res) {
  const { id } = req.params
  const { startDate, endDate, reason } = req.body
  const branchId = requireBranchId(req)

  try {
    const existing = await getLeaveById(req.tenantId, id)
    if (
      !existing ||
      existing.leaveFor !== 'branch_manager' ||
      existing.requestedBy !== req.user.id ||
      existing.branchId !== branchId
    ) {
      return fail(res, 'Leave not found', 404)
    }

    // Only pending requests can be edited by BM
    if (existing.status !== 'pending') {
      return fail(res, 'Only pending leave requests can be edited', 400)
    }

    const nextStart = startDate || existing.startDate
    const nextEnd = endDate || existing.endDate

    const overlap = await findOverlappingLeave(req.tenantId, {
      leaveFor: 'branch_manager',
      requestedBy: req.user.id,
      startDate: nextStart,
      endDate: nextEnd,
      excludeId: id,
    })
    if (overlap) {
      return fail(res, overlapMessage(overlap), 409)
    }

    const updated = await updateLeave(req.tenantId, id, {
      startDate: nextStart,
      endDate: nextEnd,
      reason: reason !== undefined ? reason : existing.reason,
      status: 'pending',
    })
    return success(res, updated)
  } catch (err) {
    return failFromError(res, err, 'Failed to update leave request')
  }
}

export async function removeMyLeave(req, res) {
  const { id } = req.params
  const branchId = requireBranchId(req)

  try {
    const existing = await getLeaveById(req.tenantId, id)
    if (
      !existing ||
      existing.leaveFor !== 'branch_manager' ||
      existing.requestedBy !== req.user.id ||
      existing.branchId !== branchId
    ) {
      return fail(res, 'Leave not found', 404)
    }

    if (existing.status !== 'pending') {
      return fail(res, 'Only pending leave requests can be deleted', 400)
    }

    const deleted = await deleteLeave(req.tenantId, id)
    return success(res, deleted)
  } catch (err) {
    return failFromError(res, err, 'Failed to delete leave request')
  }
}
