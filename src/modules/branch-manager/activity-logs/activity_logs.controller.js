import { listActivityLogs } from './activity_logs.model.js'
import { resolveListBranchId } from '../staff/staff.access.js'
import { success } from '../../../utils/response.util.js'
import { paginatedResult } from '../../../utils/pagination.util.js'

export async function activityLogsList(req, res) {
  const query = { ...req.validated.query }
  query.branchId = resolveListBranchId(req, query.branchId)
  const result = await listActivityLogs(req.tenantId, query)
  return success(res, paginatedResult(result.items, result))
}
