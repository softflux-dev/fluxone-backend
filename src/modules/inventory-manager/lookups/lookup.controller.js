import { listBranchesForLookup, listEmployeesForLookup, listBranchInventory } from './lookup.model.js'
import { resolveInventoryScope } from '../shared.access.js'
import { fail, failFromError, success } from '../../../utils/response.util.js'
import { paginatedResult } from '../../../utils/pagination.util.js'


export async function employees(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const result = await listEmployeesForLookup(tenantId, { ...req.validated.query, branchId })
    return success(res, paginatedResult(result.items, result))
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function branches(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    return success(res, await listBranchesForLookup(tenantId, { branchId }))
  } catch (err) {
    return failFromError(res, err)
  }
}

export async function branchInventory(req, res) {
  try {
    const { tenantId, branchId } = resolveInventoryScope(req)
    const result = await listBranchInventory(tenantId, {
      ...req.validated.query,
      branchId,
    })
    return success(res, paginatedResult(result.items, result))
  } catch (err) {
    return failFromError(res, err)
  }
}
