import { createStockRequest, listStockRequests } from './stock_request.model.js'
import { resolveListBranchId, resolveScopedBranchId } from '../staff/staff.access.js'
import { notifyInventoryManagersOfStockRequest } from '../../notifications/notifications.service.js'
import { success, fail, failFromError } from '../../../utils/response.util.js'

export async function stockRequestList(req, res) {
  const branchId = resolveListBranchId(req, req.validated.query?.branchId)
  return success(res, await listStockRequests(req.tenantId, { ...req.validated.query, branchId }))
}

export async function addStockRequest(req, res) {
  try {
    const branchId = resolveScopedBranchId(req, req.validated.body.branchId)
    const row = await createStockRequest(req.tenantId, {
      ...req.validated.body,
      createdBy: req.user.id,
      branchId,
    })

    // Alert Inventory Managers (bell + Notifications page)
    try {
      await notifyInventoryManagersOfStockRequest(req.tenantId, row, {
        managerName: req.user.name || req.user.fullName || 'Branch Manager',
        branchName: row.branchName,
      })
    } catch (notifyErr) {
      console.error(
        '[stock-requests] Failed to notify inventory managers:',
        notifyErr?.message || notifyErr,
      )
    }

    return success(res, row, 201)
  } catch (err) {
    return failFromError(res, err, 'Failed to create stock request')
  }
}
