import { listAttendance, upsertAttendance } from './attendance.model.js'
import { resolveListBranchId } from '../staff/staff.access.js'
import { success } from '../../../utils/response.util.js'

export async function attendanceList(req, res) {
  const branchId = resolveListBranchId(req, req.validated.query?.branchId)
  const rows = await listAttendance(req.tenantId, { branchId })
  return success(res, rows)
}

export async function markAttendance(req, res) {
  const row = await upsertAttendance(req.tenantId, {
    ...req.validated.body,
    createdBy: req.user.id,
  })
  return success(res, row, 201)
}
