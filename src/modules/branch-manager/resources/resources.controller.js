import {
  createHardware,
  deleteHardware,
  listHardware,
  updateHardware,
} from './hardware.model.js'
import {
  createItemScale,
  deleteItemScale,
  listItemScales,
  updateItemScale,
} from './scales.model.js'
import { fail, failFromError, success } from '../../../utils/response.util.js'
import { resolveUploadUrl } from '../../../utils/uploadUrl.util.js'
import { isTenantWideAdmin, resolveTenantBranchScope } from '../../../utils/branchScope.util.js'
import { writeAdminActivity } from '../../../utils/adminActivityLog.util.js'

function resolveBranchId(req, explicit) {
  if (isTenantWideAdmin(req.user?.role)) {
    return explicit || req.user?.branchId || null
  }
  return resolveTenantBranchScope(req).branchId
}

export async function hardwareList(req, res) {
  try {
    const branchId = resolveBranchId(req, req.validated.query.branchId)
    if (!isTenantWideAdmin(req.user?.role) && !branchId) {
      return fail(res, 'Branch context is required', 400)
    }
    const type = req.validated.query.type || undefined
    const q = req.validated.query.q || undefined
    const rows = await listHardware(req.tenantId, {
      branchId,
      type,
      q,
      scheduleStart: req.validated.query.scheduleStart || null,
      scheduleEnd: req.validated.query.scheduleEnd || null,
      workingDays: req.validated.query.workingDays || null,
      excludeStaffId: req.validated.query.excludeStaffId || null,
      includeBusy: req.validated.query.includeBusy ?? false,
      includeInactive: req.validated.query.includeInactive ?? false,
      forRole: req.validated.query.forRole || null,
    })
    return success(res, rows)
  } catch (err) {
    return failFromError(res, err, 'Failed to list hardware')
  }
}

export async function hardwareCreate(req, res) {
  try {
    const body = req.validated.body
    const branchId = resolveBranchId(req, body.branchId)
    if (!branchId) {
      return fail(res, 'branchId is required', 400)
    }
    const imageUrl = resolveUploadUrl(req.file, req)
    const row = await createHardware(req.tenantId, {
      ...body,
      branchId,
      imageUrl: imageUrl || body.imageUrl || null,
    })
    const deviceLabel = row.name || row.code || row.id
    await writeAdminActivity(req.tenantId, {
      branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'hardware',
      action: 'hardware_register',
      entityType: 'hardware',
      entityId: row.id,
      actionText: `Registered new device "${deviceLabel}".`,
      affectedItem: deviceLabel,
    })
    return success(res, row, 201)
  } catch (err) {
    return failFromError(res, err, 'Failed to create hardware')
  }
}

export async function hardwareUpdate(req, res) {
  try {
    const body = req.validated.body
    const { id } = req.validated.params
    const branchId = resolveBranchId(req, body.branchId)
    const imageUrl = resolveUploadUrl(req.file, req)
    const payload = { ...body }
    if (imageUrl) {
      payload.imageUrl = imageUrl
      delete payload.image
    } else {
      // Keep existing image when no new file is uploaded.
      delete payload.image
      delete payload.imageUrl
    }
    const row = await updateHardware(req.tenantId, id, payload, { branchId })
    if (!row) return fail(res, 'Hardware not found', 404)
    const deviceLabel = row.name || row.code || row.id
    const statusChanged =
      body.status !== undefined || body.accessStatus !== undefined || body.isActive !== undefined
    await writeAdminActivity(req.tenantId, {
      branchId: row.branchId || branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'hardware',
      action: statusChanged ? 'hardware_status' : 'hardware_update',
      entityType: 'hardware',
      entityId: row.id,
      actionText: statusChanged
        ? `Changed status of device "${deviceLabel}" to ${row.status || row.accessStatus || row.isActive}.`
        : `Updated device "${deviceLabel}".`,
      affectedItem: deviceLabel,
    })
    return success(res, row)
  } catch (err) {
    return failFromError(res, err, 'Failed to update hardware')
  }
}

export async function hardwareRemove(req, res) {
  try {
    const branchId = resolveBranchId(req, req.validated.query?.branchId)
    const { id } = req.validated.params
    const row = await deleteHardware(req.tenantId, id, { branchId })
    if (!row) return fail(res, 'Hardware not found', 404)
    const deviceLabel = row.name || row.code || row.id
    await writeAdminActivity(req.tenantId, {
      branchId: row.branchId || branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'hardware',
      action: 'hardware_remove',
      entityType: 'hardware',
      entityId: row.id,
      actionText: `Removed device "${deviceLabel}".`,
      affectedItem: deviceLabel,
    })
    return success(res, { id: row.id, isActive: false, deactivated: true })
  } catch (err) {
    return failFromError(res, err, 'Failed to deactivate hardware')
  }
}

export async function scalesList(req, res) {
  try {
    const q = req.validated.query.q || undefined
    const rows = await listItemScales(req.tenantId, { q })
    return success(res, rows)
  } catch (err) {
    return failFromError(res, err, 'Failed to list scales')
  }
}

export async function scalesCreate(req, res) {
  try {
    const row = await createItemScale(req.tenantId, req.validated.body)
    return success(res, row, 201)
  } catch (err) {
    return failFromError(res, err, 'Failed to create scale')
  }
}

export async function scalesUpdate(req, res) {
  try {
    const { id } = req.validated.params
    const row = await updateItemScale(req.tenantId, id, req.validated.body)
    if (!row) return fail(res, 'Scale not found', 404)
    return success(res, row)
  } catch (err) {
    return failFromError(res, err, 'Failed to update scale')
  }
}

export async function scalesRemove(req, res) {
  try {
    const { id } = req.validated.params
    const row = await deleteItemScale(req.tenantId, id)
    if (!row) return fail(res, 'Scale not found', 404)
    return success(res, { message: 'Scale deleted successfully', id: row.id })
  } catch (err) {
    return failFromError(res, err, 'Failed to delete scale')
  }
}
