import bcrypt from 'bcryptjs'
import {
  createStaffUser,
  deleteStaff,
  getStaffById,
  listStaff,
  listStaffForExport,
  setStaffStatus,
  updateStaff,
} from './staff.model.js'
import {
  assertStaffBranchAccess,
  resolveListBranchId,
  resolveScopedBranchId,
  sanitizeStaffWritePayload,
} from './staff.access.js'
import { validateShiftAgainstBranchHours } from './schedule.validation.js'
import { getBranchHours } from '../../b2b-admin/branches/branches.model.js'
import { ROLE_IDS, ROLES, BCRYPT_COST } from '../../../config/constants.js'
import { fail, success, failFromError } from '../../../utils/response.util.js'
import { paginatedResult } from '../../../utils/pagination.util.js'
import { resolveUploadUrl } from '../../../utils/uploadUrl.util.js'
import { reallocateStaffHardware } from './hardwareAllocation.model.js'
import { writeAdminActivity } from '../../../utils/adminActivityLog.util.js'

function roleLabel(role) {
  const map = {
    [ROLES.BRANCH_MANAGER]: 'Branch Manager',
    [ROLES.INVENTORY_MANAGER]: 'Inventory Manager',
    [ROLES.CASHIER]: 'Cashier',
    [ROLES.BRANCH_ADMIN]: 'Local Admin',
    [ROLES.PRODUCTION_STAFF]: 'Production Staff',
    [ROLES.DELIVERY_STAFF]: 'Delivery Staff',
  }
  return map[role] || role || '—'
}

function bmBranchFilter(req) {
  if (req.user?.role === ROLES.BRANCH_MANAGER) {
    return req.user.branchId || null
  }
  return null
}

function hasScheduleField(body) {
  return (
    body.scheduleStart !== undefined ||
    body.scheduleEnd !== undefined ||
    body.scheduleBreakStart !== undefined ||
    body.scheduleBreakEnd !== undefined
  )
}

async function rejectIfShiftOutsideBranchHours(res, tenantId, branchId, schedule) {
  const hours = await getBranchHours(tenantId, branchId)
  if (hours === null) {
    return fail(res, 'Branch not found', 404)
  }
  const message = validateShiftAgainstBranchHours(schedule, hours)
  if (message) return fail(res, message, 400)
  return null
}

export async function staffList(req, res) {
  const query = { ...req.validated.query }
  query.branchId = resolveListBranchId(req, query.branchId)
  const result = await listStaff(req.tenantId, query)
  return success(res, paginatedResult(result.items, result))
}

// Full filtered roster rows for client CSV (Products-style Option B)
export async function staffExport(req, res) {
  const query = { ...req.validated.query }
  query.branchId = resolveListBranchId(req, query.branchId)
  const rows = await listStaffForExport(req.tenantId, query)
  return success(res, { rows, exported: rows.length })
}

export async function createStaff(req, res) {
  const body = req.validated.body
  const branchId = resolveScopedBranchId(req, body.branchId)

  if (req.user.role === ROLES.B2B_ADMIN && !branchId) {
    return fail(res, 'branchId is required when creating staff as B2B Admin', 400)
  }

  const hoursError = await rejectIfShiftOutsideBranchHours(res, req.tenantId, branchId, body)
  if (hoursError) return hoursError

  try {
    const passwordHash = await bcrypt.hash(body.password, BCRYPT_COST)
    const created = await createStaffUser(req.tenantId, {
      ...body,
      role: body.role,
      roleId: ROLE_IDS[body.role],
      passwordHash,
      createdBy: req.user.id,
      branchId,
      imageUrl: resolveUploadUrl(req.file, req),
    })
    await writeAdminActivity(req.tenantId, {
      branchId,
      actorUserId: req.user.id,
      actorRole: req.user.role,
      category: 'employees',
      action: 'staff_create',
      entityType: 'user',
      entityId: created.id,
      actionText: `Added new employee ${created.fullName} with role ${roleLabel(created.role)}.`,
      affectedItem: created.fullName,
    })
    return success(res, created, 201)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function staffDetail(req, res) {
  const row = await getStaffById(req.tenantId, req.validated.params.id, {
    branchId: bmBranchFilter(req),
  })
  assertStaffBranchAccess(req, row)
  return success(res, row)
}

export async function patchStaff(req, res) {
  const body = sanitizeStaffWritePayload(req, { ...req.validated.body })
  if (body.password) {
    body.passwordHash = await bcrypt.hash(body.password, BCRYPT_COST)
    delete body.password
  }
  const imageUrl = resolveUploadUrl(req.file, req)
  if (imageUrl) body.imageUrl = imageUrl

  if (hasScheduleField(body)) {
    const existing = await getStaffById(req.tenantId, req.validated.params.id, {
      branchId: bmBranchFilter(req),
    })
    if (!existing) return fail(res, 'Staff not found', 404)

    const nextBranchId =
      body.branchId !== undefined ? body.branchId : existing.branchId
    const mergedSchedule = {
      scheduleStart:
        body.scheduleStart !== undefined ? body.scheduleStart : existing.scheduleStart,
      scheduleEnd: body.scheduleEnd !== undefined ? body.scheduleEnd : existing.scheduleEnd,
      scheduleBreakStart:
        body.scheduleBreakStart !== undefined
          ? body.scheduleBreakStart
          : existing.scheduleBreakStart,
      scheduleBreakEnd:
        body.scheduleBreakEnd !== undefined
          ? body.scheduleBreakEnd
          : existing.scheduleBreakEnd,
    }

    const hoursError = await rejectIfShiftOutsideBranchHours(
      res,
      req.tenantId,
      nextBranchId,
      mergedSchedule,
    )
    if (hoursError) return hoursError
  }

  try {
    const before = await getStaffById(req.tenantId, req.validated.params.id, {
      branchId: bmBranchFilter(req),
    })
    const row = await updateStaff(req.tenantId, req.validated.params.id, body, {
      branchId: bmBranchFilter(req),
    })
    if (!row) return fail(res, 'Staff not found', 404)
    const branchId = row.branchId || before?.branchId
    if (body.role && before && before.role !== body.role) {
      await writeAdminActivity(req.tenantId, {
        branchId,
        actorUserId: req.user.id,
        actorRole: req.user.role,
        category: 'employees',
        action: 'staff_role_change',
        entityType: 'user',
        entityId: row.id,
        actionText: `Changed role of ${row.fullName} from ${roleLabel(before.role)} to ${roleLabel(row.role)}.`,
        affectedItem: row.fullName,
      })
    } else {
      await writeAdminActivity(req.tenantId, {
        branchId,
        actorUserId: req.user.id,
        actorRole: req.user.role,
        category: 'employees',
        action: 'staff_update',
        entityType: 'user',
        entityId: row.id,
        actionText: `Edited profile of employee ${row.fullName}.`,
        affectedItem: row.fullName,
      })
    }
    return success(res, row)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function patchStaffStatus(req, res) {
  const before = await getStaffById(req.tenantId, req.validated.params.id, {
    branchId: bmBranchFilter(req),
  })
  const row = await setStaffStatus(
    req.tenantId,
    req.validated.params.id,
    req.validated.body.status,
    { branchId: bmBranchFilter(req) },
  )
  if (!row) return fail(res, 'Staff not found', 404)
  const active = row.status === 'active'
  await writeAdminActivity(req.tenantId, {
    branchId: row.branchId || before?.branchId,
    actorUserId: req.user.id,
    actorRole: req.user.role,
    category: 'employees',
    action: 'staff_status',
    entityType: 'user',
    entityId: row.id,
    actionText: active
      ? `Reactivated employee ${row.fullName} (${roleLabel(row.role)}).`
      : `Deactivated employee ${row.fullName} (${roleLabel(row.role)}).`,
    affectedItem: row.fullName,
  })
  return success(res, row)
}

export async function reallocateHardware(req, res) {
  const existing = await getStaffById(req.tenantId, req.validated.params.id, {
    branchId: bmBranchFilter(req),
  })
  if (!existing) return fail(res, 'Staff not found', 404)
  assertStaffBranchAccess(req, existing)

  try {
    const data = await reallocateStaffHardware(req.tenantId, existing.id, {
      hardwareDeviceId: req.validated.body.hardwareDeviceId,
      hardwareAllocationStart: req.validated.body.hardwareAllocationStart || null,
      hardwareAllocationEnd: req.validated.body.hardwareAllocationEnd || null,
    })
    return success(res, data)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function removeStaff(req, res) {
  const before = await getStaffById(req.tenantId, req.validated.params.id, {
    branchId: bmBranchFilter(req),
  })
  const deleted = await deleteStaff(req.tenantId, req.validated.params.id, {
    branchId: bmBranchFilter(req),
  })
  if (!deleted) return fail(res, 'Staff not found', 404)
  if (before) {
    await writeAdminActivity(req.tenantId, {
      branchId: before.branchId,
      actorUserId: req.user.id,
      actorRole: req.user.role,
      category: 'employees',
      action: 'staff_delete',
      entityType: 'user',
      entityId: deleted.id,
      actionText: `Deleted employee ${before.fullName} (${roleLabel(before.role)}).`,
      affectedItem: before.fullName,
    })
  }
  return success(res, { id: deleted.id, deleted: true })
}
