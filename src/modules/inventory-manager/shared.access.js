import { isTenantWideAdmin, resolveTenantBranchScope } from '../../utils/branchScope.util.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function readQueryBranchId(req) {
  return req.validated?.query?.branchId || req.query?.branchId || null
}

function readBodyBranchId(req) {
  return req.validated?.body?.branchId || req.body?.branchId || null
}

// Inventory APIs: products, categories, suppliers, POs, stock ledger, reports, etc.
export function resolveInventoryScope(req) {
  const queryBranchId = readQueryBranchId(req)
  return resolveTenantBranchScope(req, queryBranchId)
}

// Creates must persist branch_id — B2B admin supplies body.branchId when not filtering.
export function resolveInventoryCreateScope(req) {
  const scoped = resolveInventoryScope(req)
  if (scoped.branchId) return scoped

  const bodyBranchId = readBodyBranchId(req)
  if (!bodyBranchId) {
    throw httpError(422, 'branchId is required to create inventory records')
  }
  return { tenantId: scoped.tenantId, branchId: bodyBranchId }
}

// Stock movements / transfers: branch roles use JWT branch; B2B may pass body branchId.
export function resolveInventoryBranchId(req, bodyBranchId = null) {
  const { branchId } = resolveInventoryScope(req)
  if (!isTenantWideAdmin(req.user?.role)) {
    return branchId
  }
  return bodyBranchId || branchId || null
}
