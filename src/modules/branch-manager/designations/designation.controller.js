import {
  createDesignation,
  deleteDesignation,
  getDesignationById,
  listDesignations,
  updateDesignation,
} from './designation.model.js'
import { fail, success } from '../../../utils/response.util.js'
import { paginatedResult } from '../../../utils/pagination.util.js'

export async function designationsList(req, res) {
  const result = await listDesignations(req.tenantId, req.validated.query)
  return success(res, paginatedResult(result.items, result))
}

export async function designationDetail(req, res) {
  const row = await getDesignationById(req.tenantId, req.validated.params.id)
  if (!row) return fail(res, 'Designation not found', 404)
  return success(res, row)
}

export async function addDesignation(req, res) {
  const row = await createDesignation(req.tenantId, req.validated.body)
  return success(res, row, 201)
}

export async function patchDesignation(req, res) {
  const row = await updateDesignation(req.tenantId, req.validated.params.id, req.validated.body)
  if (!row) return fail(res, 'Designation not found', 404)
  return success(res, row)
}

export async function removeDesignation(req, res) {
  const row = await deleteDesignation(req.tenantId, req.validated.params.id)
  if (!row) return fail(res, 'Designation not found', 404)
  return success(res, { id: row.id, isActive: false, deactivated: true })
}
