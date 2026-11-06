import { resolveListBranchId } from '../staff/staff.access.js'
import { success, fail, failFromError } from '../../../utils/response.util.js'
import {
  getActiveScale,
  saveScaleVersion,
  createEvaluation,
  listRoster,
  getEmployeePerformanceDetail,
  LATEST_EVALUATION_SCORE_SQL,
} from './performance.model.js'

// BM locked to JWT branch for roster / score writes
function requireBranchId(req) {
  try {
    return resolveListBranchId(req, null)
  } catch (err) {
    err.status = err.status || 403
    throw err
  }
}

export async function listScales(req, res) {
  try {
    const data = await getActiveScale(req.tenantId)
    return success(res, data)
  } catch (err) {
    return failFromError(res, err, 'Failed to fetch scoring scale')
  }
}

// PUT /performance/scales — save full criteria set as a new version when changed
export async function saveScale(req, res) {
  try {
    const data = await saveScaleVersion(req.tenantId, {
      criteria: req.validated.body.criteria,
      createdBy: req.user?.id || null,
    })
    return success(res, data)
  } catch (err) {
    return failFromError(res, err, 'Failed to save scoring scale')
  }
}

export async function getStaffScores(req, res) {
  try {
    const branchId = requireBranchId(req)
    if (!branchId) {
      return fail(res, 'Performance roster requires a branch assignment', 400)
    }
    const rows = await listRoster(req.tenantId, {
      branchId,
      actorUserId: req.user?.id || null,
    })
    return success(res, rows)
  } catch (err) {
    return failFromError(res, err, 'Failed to fetch performance scores')
  }
}

export async function postEvaluation(req, res) {
  try {
    const branchId = requireBranchId(req)
    if (!branchId) {
      return fail(res, 'Performance scoring requires a branch assignment', 400)
    }
    const { staffId, remarks, items } = req.validated.body
    const data = await createEvaluation(req.tenantId, {
      staffId,
      branchId,
      remarks,
      items,
      createdBy: req.user?.id || null,
    })
    return success(res, data, 201)
  } catch (err) {
    return failFromError(res, err, 'Failed to record evaluation')
  }
}

export async function getEmployeeDetail(req, res) {
  try {
    const branchId = requireBranchId(req)
    if (!branchId) {
      return fail(res, 'Performance detail requires a branch assignment', 400)
    }
    const rangeRaw = req.validated.query.range || '12M'
    const range = String(rangeRaw).toUpperCase() === 'ALL' ? 'All' : String(rangeRaw).toUpperCase()
    const data = await getEmployeePerformanceDetail(req.tenantId, {
      staffId: req.validated.params.staffId,
      branchId,
      range,
      timelinePage: req.validated.query.timelinePage || 1,
      timelineLimit: req.validated.query.timelineLimit || 10,
    })
    return success(res, data)
  } catch (err) {
    return failFromError(res, err, 'Failed to load employee performance')
  }
}

// Dashboard compatibility export
export { LATEST_EVALUATION_SCORE_SQL as WEIGHTED_RATING_SQL }
