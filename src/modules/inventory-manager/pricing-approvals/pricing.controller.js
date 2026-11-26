import { listApprovals, resolveApprovals } from './pricing.model.js'
import { resolveInventoryScope } from '../shared.access.js'
import { failFromError, success } from '../../../utils/response.util.js'

export async function approvalsList(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const items = await listApprovals(tenantId, {
      branchId,
      status: req.validated?.query?.status || 'pending',
    })
    return success(res, { items, count: items.length })
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function approvalsResolve(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const { ids, action } = req.validated.body
    const resolved = await resolveApprovals(tenantId, {
      ids,
      action,
      userId: req.user?.id || null,
      branchId,
    })
    return success(res, { resolved, count: resolved.length })
  } catch (err) {
    return failFromError(res, err)
  }
}
