import {
  listManagerLeaveRequests,
  getLeaveById,
  decideLeave,
} from '../../branch-manager/leaves/leaves.model.js'
import { notifyBmOfLeaveDecision } from '../../notifications/notifications.service.js'
import { normalizeImageUrl } from '../../../utils/uploadUrl.util.js'
import { matchesDisplayRef, normalizeSearchQuery } from '../../../utils/displayRef.util.js'
import { success, fail, failFromError } from '../../../utils/response.util.js'

// Admin inbox of BM self-leave requests
export async function managerLeavesList(req, res) {
  const branchId = req.query?.branchId || null
  const status = req.query?.status || null
  const q = normalizeSearchQuery(req.query?.q || '').toLowerCase()
  const rows = await listManagerLeaveRequests(req.tenantId, { branchId, status })

  const mapped = rows.map((row) => ({
    ...row,
    managerImageUrl: normalizeImageUrl(row.managerImageUrl) || row.managerImageUrl || null,
  }))

  // Search by Leave ID (UUID or LV-XXXXXXXX) or manager name
  const filtered = q
    ? mapped.filter((row) => {
        const name = String(row.managerName || '').toLowerCase()
        return matchesDisplayRef(row.id, q, 'LV') || name.includes(q)
      })
    : mapped

  return success(res, filtered)
}

export async function decideManagerLeave(req, res) {
  const { id } = req.params
  const { status, decisionReason } = req.body

  try {
    if (status === 'rejected' && !String(decisionReason || '').trim()) {
      return fail(res, 'A reason is required when rejecting a leave request', 400)
    }

    const existing = await getLeaveById(req.tenantId, id)
    if (!existing || existing.leaveFor !== 'branch_manager') {
      return fail(res, 'Leave request not found', 404)
    }
    if (existing.status !== 'pending') {
      return fail(res, 'Only pending leave requests can be decided', 400)
    }

    const updated = await decideLeave(req.tenantId, id, {
      status,
      decidedBy: req.user.id,
      decisionReason: decisionReason?.trim() || null,
    })
    if (!updated) {
      return fail(res, 'Leave request could not be updated', 409)
    }

    // In-app notify BM (non-blocking) — email path removed; notifications.service owns this
    try {
      await notifyBmOfLeaveDecision(req.tenantId, updated, {
        status,
        decisionReason: updated.decisionReason,
        decidedByName: req.user.name || 'Admin',
      })
    } catch (notifyErr) {
      console.error('[admin/leaves] Failed to notify BM:', notifyErr?.message || notifyErr)
    }

    return success(res, {
      message: status === 'approved' ? 'Leave approved' : 'Leave rejected',
      leave: updated,
    })
  } catch (err) {
    return failFromError(res, err, 'Failed to decide leave request')
  }
}
