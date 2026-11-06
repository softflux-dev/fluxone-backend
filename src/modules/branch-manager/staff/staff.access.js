import { ROLES } from '../../../config/constants.js'
import { isTenantWideAdmin, resolveTenantBranchScope } from '../../../utils/branchScope.util.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

// Roles BM can create via Staff API (excludes BM / B2B admin).
export const CREATABLE_STAFF_ROLES = [
  ROLES.INVENTORY_MANAGER,
  ROLES.CASHIER,
  ROLES.PRODUCTION_STAFF,
  ROLES.DELIVERY_STAFF,
  ROLES.WEBSITE_MANAGER,
]

// SQL `IN (...)` list for creatable staff role slugs.
export const CREATABLE_STAFF_ROLE_SQL = CREATABLE_STAFF_ROLES.map((slug) => `'${slug}'`).join(', ')

// Fixed staff designations auto-mapped from system role (no custom designation picker).
export const STAFF_ROLE_TO_DESIGNATION = {
  [ROLES.INVENTORY_MANAGER]: 'Inventory Manager',
  [ROLES.CASHIER]: 'Cashier',
  [ROLES.PRODUCTION_STAFF]: 'Production Staff',
  [ROLES.DELIVERY_STAFF]: 'Delivery Staff',
  [ROLES.WEBSITE_MANAGER]: 'Website Manager',
}

// Branch roles use JWT branch on writes. B2B admin may pass body.branchId.
export function resolveScopedBranchId(req, bodyBranchId) {
  if (isTenantWideAdmin(req.user?.role)) {
    return bodyBranchId || null
  }
  return resolveTenantBranchScope(req).branchId
}

// List/filter branch scope — branch roles locked to JWT; B2B admin may filter or see all.
export function resolveListBranchId(req, queryBranchId) {
  return resolveTenantBranchScope(req, queryBranchId || null).branchId
}

// Ensures a staff row is visible/editable for the caller.
// BM: must match JWT branch. B2B: any staff in tenant.
export function assertStaffBranchAccess(req, staffRow) {
  if (!staffRow) {
    throw httpError(404, 'Staff not found')
  }

  if (!isTenantWideAdmin(req.user?.role)) {
    const tokenBranchId = req.user.branchId || null
    if (!tokenBranchId) {
      throw httpError(403, 'This account is not assigned to a branch')
    }
    if (staffRow.branchId !== tokenBranchId) {
      throw httpError(404, 'Staff not found')
    }
  }

  return staffRow
}

// Strip branch reassignment from BM update payloads.
export function sanitizeStaffWritePayload(req, body) {
  const next = { ...body }
  if (!isTenantWideAdmin(req.user?.role)) {
    delete next.branchId
    next.branchId = req.user.branchId
  }
  return next
}
