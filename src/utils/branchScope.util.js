import { ROLES } from '../config/constants.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

// True only for company admin — may list all branches or filter by branchId.
export function isTenantWideAdmin(role) {
  return role === ROLES.B2B_ADMIN
}

// Resolve tenant + branch for branch-owned data (catalog, sales, stock, etc.).
// - b2b_admin: optional explicitBranchId (null = all branches in tenant)
// - all other roles: JWT branch only; client branchId is ignored
export function resolveTenantBranchScope(req, explicitBranchId = null) {
  const tenantId = req.tenantId
  const role = req.user?.role
  const tokenBranchId = req.user?.branchId || null

  if (isTenantWideAdmin(role)) {
    return { tenantId, branchId: explicitBranchId || null }
  }

  if (!tokenBranchId) {
    throw httpError(403, 'This account is not assigned to a branch')
  }

  return { tenantId, branchId: tokenBranchId }
}
