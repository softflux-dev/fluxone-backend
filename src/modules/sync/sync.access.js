// sync.access.js — branch resolution + role lock for sync push/pull/events.
// Purpose: cashiers/BM/IM/branch_admin only touch their own branchId; admins wider on events.
// Throws syncHttpError with BRANCH_* codes when branch missing or mismatched.
// Read next: sync.controller.js (call sites), sync.errors.js (code catalog).

import { ROLES } from '../../config/constants.js'
import { isTenantWideAdmin } from '../../utils/branchScope.util.js'
import { SYNC_ERROR_CODES, syncHttpError } from './sync.errors.js'

function httpError(status, message, code) {
  return syncHttpError(status, message, { code })
}

// Cashier, BM, IM, branch_admin — never read/write another branch via sync.
const BRANCH_LOCKED_ROLES = new Set([
  ROLES.CASHIER,
  ROLES.BRANCH_MANAGER,
  ROLES.INVENTORY_MANAGER,
  ROLES.BRANCH_ADMIN,
])

function assertBranchLockedSyncAccess(req, branchId) {
  if (!BRANCH_LOCKED_ROLES.has(req.user?.role)) return

  const tokenBranchId = req.user?.branchId || null
  if (!tokenBranchId) {
    throw httpError(403, 'This account is not assigned to a branch', SYNC_ERROR_CODES.BRANCH_ACCESS_DENIED)
  }
  if (tokenBranchId !== branchId) {
    throw httpError(403, 'Branch access denied', SYNC_ERROR_CODES.BRANCH_ACCESS_DENIED)
  }
}

// Resolve branchId for sync pull (bootstrap/delta/sales).
export function resolveSyncPullBranchId(req, queryBranchId) {
  const branchId = queryBranchId || req.user?.branchId || null
  if (!branchId) {
    throw httpError(422, 'branchId is required', SYNC_ERROR_CODES.BRANCH_REQUIRED)
  }

  assertBranchLockedSyncAccess(req, branchId)
  return branchId
}

// Push resolves branch from body or JWT; branch-scoped roles must match token.
export function resolveSyncPushBranchId(req, bodyBranchId) {
  const branchId = bodyBranchId || req.user?.branchId || null
  if (!branchId) {
    throw httpError(422, 'branchId is required', SYNC_ERROR_CODES.BRANCH_REQUIRED)
  }

  assertBranchLockedSyncAccess(req, branchId)
  return branchId
}

// GET /api/sync/events — tenant admin sees all; others only their branch.
export function resolveSyncEventsBranchFilter(req, queryBranchId) {
  if (isTenantWideAdmin(req.user?.role)) {
    return queryBranchId || null
  }

  const tokenBranchId = req.user?.branchId || null
  if (!tokenBranchId) {
    throw httpError(403, 'This account is not assigned to a branch', SYNC_ERROR_CODES.BRANCH_ACCESS_DENIED)
  }
  if (queryBranchId && queryBranchId !== tokenBranchId) {
    throw httpError(403, 'Branch access denied', SYNC_ERROR_CODES.BRANCH_ACCESS_DENIED)
  }
  return tokenBranchId
}
