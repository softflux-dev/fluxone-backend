import {
  createPolicy,
  deletePolicy,
  getPolicyById,
  listPolicies,
  updatePolicy,
} from './policies.model.js'
import { fail, success, failFromError } from '../../../utils/response.util.js'
import { paginatedResult } from '../../../utils/pagination.util.js'
import { writeAdminActivity } from '../../../utils/adminActivityLog.util.js'

export async function policiesList(req, res) {
  const result = await listPolicies(req.tenantId, req.validated.query)
  return success(res, paginatedResult(result.items, result))
}

export async function policyDetail(req, res) {
  const row = await getPolicyById(req.tenantId, req.validated.params.id)
  if (!row) return fail(res, 'Policy not found', 404)
  return success(res, row)
}

export async function createPolicyHandler(req, res) {
  try {
    const row = await createPolicy(req.tenantId, req.validated.body)
    await writeAdminActivity(req.tenantId, {
      branchId: req.user?.branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'settings',
      action: 'policy_create',
      entityType: 'policy',
      entityId: row.id,
      actionText: `Created policy "${row.title || row.name || row.id}".`,
      affectedItem: row.title || row.name || row.id,
    })
    return success(res, row, 201)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function patchPolicy(req, res) {
  try {
    const row = await updatePolicy(req.tenantId, req.validated.params.id, req.validated.body)
    if (!row) return fail(res, 'Policy not found', 404)
    await writeAdminActivity(req.tenantId, {
      branchId: req.user?.branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'settings',
      action: 'policy_update',
      entityType: 'policy',
      entityId: row.id,
      actionText: `Updated policy "${row.title || row.name || row.id}".`,
      affectedItem: row.title || row.name || row.id,
    })
    return success(res, row)
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function removePolicy(req, res) {
  try {
    const before = await getPolicyById(req.tenantId, req.validated.params.id)
    const result = await deletePolicy(req.tenantId, req.validated.params.id)
    await writeAdminActivity(req.tenantId, {
      branchId: req.user?.branchId,
      actorUserId: req.user?.id,
      actorRole: req.user?.role,
      category: 'settings',
      action: 'policy_delete',
      entityType: 'policy',
      entityId: req.validated.params.id,
      actionText: `Deleted policy "${before?.title || before?.name || req.validated.params.id}".`,
      affectedItem: before?.title || before?.name || req.validated.params.id,
    })
    return success(res, result)
  } catch (err) {
    return failFromError(res, err)
  }
}
