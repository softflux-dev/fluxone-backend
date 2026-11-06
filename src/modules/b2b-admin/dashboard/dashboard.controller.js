import { getAdminDashboard } from './dashboard.model.js'
import { success, failFromError } from '../../../utils/response.util.js'

export async function overview(req, res) {
  try {
    const data = await getAdminDashboard(req.tenantId, req.validated.query)
    return success(res, data)
  } catch (err) {
    return failFromError(res, err)
  }
}
