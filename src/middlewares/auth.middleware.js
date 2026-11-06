import {
  findActiveByTokenHash,
  touchSession,
} from '../modules/auth/auth_sessions.model.js'
import {
  computeSlidingExpiresAt,
  hashesEqual,
  hashToken,
} from '../utils/sessionToken.util.js'
import { error } from '../utils/response.util.js'

export async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null

    if (!token) {
      return error(res, 'Authentication required', 401)
    }

    const tokenHash = hashToken(token)
    const session = await findActiveByTokenHash(tokenHash)

    if (!session || !hashesEqual(session.tokenHash, tokenHash)) {
      return error(res, 'Invalid or expired token', 401)
    }

    if (session.revokedAt) {
      return error(res, 'Invalid or expired token', 401)
    }

    const now = Date.now()
    if (new Date(session.expiresAt).getTime() <= now) {
      return error(res, 'Invalid or expired token', 401)
    }
    if (new Date(session.absoluteExpiresAt).getTime() <= now) {
      return error(res, 'Invalid or expired token', 401)
    }

    if (!session.isActive) {
      return error(res, 'Account deactivated. Contact your Branch Manager.', 401)
    }
    if (session.branchStatus === 'blocked') {
      return error(
        res,
        'This branch is blocked. Contact your administrator.',
        401,
      )
    }

    // Same shape as JWT era so inventory/branch/admin/sync stay unchanged.
    req.user = {
      id: session.userId,
      role: session.role,
      tenantId: session.tenantId,
      branchId: session.branchId || null,
    }
    req.tenantId = session.tenantId
    req.sessionId = session.id

    // Sliding expiry — best-effort; auth still succeeds if touch fails.
    const nextExpiresAt = computeSlidingExpiresAt(session)
    touchSession(session.id, {
      expiresAt: nextExpiresAt,
      lastSeenAt: new Date(),
    }).catch(() => {})

    next()
  } catch (err) {
    // DB blips must not look like a logout to the client.
    return next(err)
  }
}