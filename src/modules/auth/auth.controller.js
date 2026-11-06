import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { sendPasswordResetOtpEmail } from '../../mail/mail.service.js'
import {
  bumpResetAttempts,
  consumeResetToken,
  createPasswordReset,
  findActiveOtpReset,
  findAuthUserById,
  findAuthUsersByLoginId,
  findAuthUsersByLoginIdIncludingInactive,
  getResetCounts,
  markOtpVerified,
  updateAuthProfile,
  updatePasswordHash,
} from './auth.model.js'
import {
  createSession,
  revokeAllForUser,
  revokeById,
  revokeByTokenHash,
} from './auth_sessions.model.js'
import {
  buildSessionExpiryDates,
  deviceLabelFromUserAgent,
  generateOpaqueToken,
  hashToken,
  newSessionId,
  secondsUntil,
} from '../../utils/sessionToken.util.js'
import { listBranchesForLookup } from '../inventory-manager/lookups/lookup.model.js'
import { ROLES, BCRYPT_COST } from '../../config/constants.js'
import { fail, failFromError, success } from '../../utils/response.util.js'
import { resolveUploadUrl } from '../../utils/uploadUrl.util.js'
import {
  clearLoginFailures,
  isLoginLocked,
  recordLoginFailure,
} from '../../services/authLockout.service.js'

function publicUser(user) {
  return {
    id: user.id,
    name: user.fullName,
    email: user.email,
    role: user.role,
    tenantId: user.tenantId,
    tenantSlug: user.tenantSlug || null,
    tenantName: user.tenantName || null,
    defaultCurrency: user.defaultCurrency || 'PKR',
    branchId: user.branchId,
    branchName: user.branchName || null,
    openingTime: user.openingTime || null,
    closingTime: user.closingTime || null,
    workingDays: Array.isArray(user.workingDays) ? user.workingDays : [],
    imageUrl: user.imageUrl || null,
  }
}

async function branchesForUser(user) {
  if (user.role === ROLES.B2B_ADMIN) {
    const rows = await listBranchesForLookup(user.tenantId)
    return rows.map((b) => ({ id: b.id, name: b.name, code: null }))
  }

  if (user.branchId) {
    return [{ id: user.branchId, name: user.branchName || null, code: null }]
  }

  return []
}

function authPayload(user, session) {
  return {
    sessionId: session.sessionId,
    // Opaque session secret (shown once).
    token: session.token,
    // Alias for POS / older clients that read accessToken.
    accessToken: session.token,
    expiresAt: session.expiresAt,
    expiresIn: session.expiresIn,
    tenantId: user.tenantId,
    user: publicUser(user),
    branches: [],
  }
}

function requestMeta(req) {
  const userAgent = req.get?.('user-agent') || null
  return {
    userAgent,
    ipAddress: req.ip || req.socket?.remoteAddress || null,
    deviceLabel: deviceLabelFromUserAgent(userAgent),
  }
}

// Create opaque session row and return raw token once.
async function issueSession(user, req) {
  const rawToken = generateOpaqueToken()
  const sessionId = newSessionId()
  const { expiresAt, absoluteExpiresAt } = buildSessionExpiryDates()
  const meta = requestMeta(req)

  await createSession({
    id: sessionId,
    userId: user.id,
    tenantId: user.tenantId,
    tokenHash: hashToken(rawToken),
    expiresAt,
    absoluteExpiresAt,
    userAgent: meta.userAgent,
    ipAddress: meta.ipAddress,
    deviceLabel: meta.deviceLabel,
  })

  return {
    sessionId,
    token: rawToken,
    expiresAt: expiresAt.toISOString(),
    expiresIn: secondsUntil(expiresAt),
  }
}

export async function login(req, res) {
  const { password } = req.validated.body
  const loginId = (req.validated.body.id || req.validated.body.email || '').trim()
  const ip = req.ip || req.socket?.remoteAddress || 'unknown'

  // Account lockout after repeated failures (Redis when available)
  const lockState = await isLoginLocked(loginId, ip)
  if (lockState.locked) {
    res.set('Retry-After', String(lockState.retryAfterSec || 60))
    return fail(
      res,
      `Too many failed login attempts. Try again in ${lockState.retryAfterSec || 60} seconds.`,
      429,
    )
  }

  const candidates = await findAuthUsersByLoginId(loginId)
  if (!candidates.length) {
    // Clearer error when credentials are valid but the branch is blocked / account off.
    const inactiveCandidates = await findAuthUsersByLoginIdIncludingInactive(loginId)
    for (const candidate of inactiveCandidates) {
      const ok = await bcrypt.compare(password, candidate.passwordHash)
      if (!ok) continue
      if (candidate.branchId && candidate.branchStatus === 'blocked') {
        await recordLoginFailure(loginId, ip)
        return fail(
          res,
          'This branch is blocked. You cannot log in until an administrator opens it again.',
          403,
        )
      }
      if (!candidate.isActive) {
        await recordLoginFailure(loginId, ip)
        return fail(res, 'Account deactivated. Contact your administrator.', 403)
      }
    }
    await recordLoginFailure(loginId, ip)
    return fail(res, 'Invalid id or password', 401)
  }

  const matched = []
  for (const candidate of candidates) {
    const ok = await bcrypt.compare(password, candidate.passwordHash)
    if (ok) matched.push(candidate)
  }

  if (!matched.length) {
    const afterFail = await recordLoginFailure(loginId, ip)
    if (afterFail.locked) {
      res.set('Retry-After', String(afterFail.retryAfterSec || 60))
      return fail(
        res,
        `Too many failed login attempts. Try again in ${afterFail.retryAfterSec || 60} seconds.`,
        429,
      )
    }
    return fail(res, 'Invalid id or password', 401)
  }

  if (matched.length > 1) {
    return fail(
      res,
      'This User ID exists in more than one company. Contact your administrator.',
      409,
    )
  }

  const user = matched[0]
  if (user.branchId && user.branchStatus === 'blocked') {
    return fail(
      res,
      'This branch is blocked. You cannot log in until an administrator opens it again.',
      403,
    )
  }

  // Successful auth — clear failure counters for this id+IP
  await clearLoginFailures(loginId, ip)

  const session = await issueSession(user, req)
  const payload = authPayload(user, session)
  payload.branches = await branchesForUser(user)
  return success(res, payload)
}

export async function me(req, res) {
  const user = await findAuthUserById(req.user.id, req.tenantId)
  if (!user) {
    return fail(res, 'User not found', 404)
  }
  return success(res, publicUser(user))
}

export async function updateMe(req, res) {
  const body = req.validated.body
  const fullName = body.name?.trim() || undefined
  const loginId = body.id?.trim() || undefined
  const newPassword = body.password || undefined
  const currentPassword = body.currentPassword || undefined
  // New upload or replace — multer field name `image`
  const imageUrl = resolveUploadUrl(req.file, req) || undefined

  if (!fullName && !loginId && !newPassword && !imageUrl) {
    return fail(res, 'name, id, password, or image is required', 422)
  }

  try {
    if (newPassword) {
      const existing = await findAuthUserById(req.user.id, req.tenantId)
      if (!existing) return fail(res, 'User not found', 404)
      if (!currentPassword) {
        return fail(res, 'Current password is required to set a new password', 422)
      }
      const match = await bcrypt.compare(currentPassword, existing.passwordHash)
      if (!match) {
        return fail(res, 'Current password is incorrect', 401)
      }
      if (currentPassword === newPassword) {
        return fail(res, 'New password must be different from current password', 422)
      }
    }

    if (fullName || loginId || imageUrl) {
      const updated = await updateAuthProfile(req.user.id, req.tenantId, {
        fullName,
        email: loginId,
        imageUrl,
      })
      if (!updated) return fail(res, 'User not found', 404)
    }

    if (newPassword) {
      const nextHash = await bcrypt.hash(newPassword, BCRYPT_COST)
      await updatePasswordHash(req.user.id, req.tenantId, nextHash)
      // Password change → logout every device for this user.
      await revokeAllForUser(req.user.id, req.tenantId)
    }
  } catch (err) {
    return failFromError(res, err)
  }

  const user = await findAuthUserById(req.user.id, req.tenantId)
  if (!user) return fail(res, 'User not found', 404)
  return success(res, {
    ...publicUser(user),
    passwordUpdated: Boolean(newPassword),
  })
}

export async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.validated.body
  const user = await findAuthUserById(req.user.id, req.tenantId)
  if (!user) {
    return fail(res, 'User not found', 404)
  }
  const match = await bcrypt.compare(currentPassword, user.passwordHash)
  if (!match) {
    return fail(res, 'Current password is incorrect', 401)
  }
  if (currentPassword === newPassword) {
    return fail(res, 'New password must be different from current password', 422)
  }
  const nextHash = await bcrypt.hash(newPassword, BCRYPT_COST)
  await updatePasswordHash(user.id, req.tenantId, nextHash)
  await revokeAllForUser(user.id, req.tenantId)
  return success(res, { updated: true })
}

// Revoke this device only. Idempotent success so clients can clear local state.
export async function logout(req, res) {
  // Prefer session id set by authMiddleware when route is protected.
  if (req.sessionId) {
    await revokeById(req.sessionId)
    return success(res, { loggedOut: true })
  }

  const header = req.headers.authorization || ''
  if (header.startsWith('Bearer ')) {
    const raw = header.slice(7).trim()
    if (raw) {
      await revokeByTokenHash(hashToken(raw))
    }
  }

  return success(res, { loggedOut: true })
}

// Revoke every session for the authenticated user (this tenant).
export async function logoutAll(req, res) {
  await revokeAllForUser(req.user.id, req.tenantId)
  return success(res, { loggedOutAll: true })
}

// ---------------------------------------------------------------------------
// Forgot password (email OTP)
// ---------------------------------------------------------------------------
const OTP_TTL_MIN = 10
const RESET_TOKEN_TTL_MIN = 10
const MAX_OTP_ATTEMPTS = 5
const MAX_OTPS_PER_WINDOW = 5
const OTP_WINDOW_MIN = 15 // auth.model.js ke INTERVAL '15 minutes' se match hona chahiye

const otpHash = (userId, otp) =>
  crypto.createHash('sha256').update(`${userId}:${otp}`).digest('hex')

// API 1: OTP email karo
export async function forgotPassword(req, res) {
  const loginId = req.validated.body.id.trim()

  try {
    const users = await findAuthUsersByLoginId(loginId)

    if (users.length === 0) {
      // active user nahi mila: check karo account band ya branch blocked to nahi
      const inactive = await findAuthUsersByLoginIdIncludingInactive(loginId)
      if (inactive.length > 0) {
        return fail(
          res,
          'This account is deactivated or its branch is blocked. Contact your administrator.',
          403,
        )
      }
      return fail(res, 'This User ID is not registered', 404)
    }

    if (users.length > 1) {
      return fail(
        res,
        'This User ID exists in more than one company. Contact your administrator.',
        409,
      )
    }

    const user = users[0]
    const counts = await getResetCounts(user.id, user.tenantId)

    if (counts.recent > 0) {
      return fail(res, 'Please wait 60 seconds before requesting another OTP.', 429)
    }
    if (counts.windowCount >= MAX_OTPS_PER_WINDOW) {
      return fail(
        res,
        `Too many OTP requests. Please try again after ${OTP_WINDOW_MIN} minutes.`,
        429,
      )
    }

    const otp = String(crypto.randomInt(100000, 1000000))
    await createPasswordReset({
      userId: user.id,
      tenantId: user.tenantId,
      otpHash: otpHash(user.id, otp),
      ttlMinutes: OTP_TTL_MIN,
    })
    if (process.env.NODE_ENV !== 'production') {
      console.info('[auth] DEV ONLY reset OTP:', { loginId, otp }) // production mein kabhi nahi
    }
    void sendPasswordResetOtpEmail({
      toEmail: user.email,
      otp,
      expiresInMinutes: OTP_TTL_MIN,
    })

    return success(res, { message: 'An OTP has been sent to your registered email.' })
  } catch (err) {
    console.error('[auth] forgotPassword failed:', err?.message || err)
    return failFromError(res, err)
  }
}

// API 2: OTP verify
export async function verifyOtp(req, res) {
  const loginId = req.validated.body.id.trim()
  const { otp } = req.validated.body
  const invalid = () => fail(res, 'Invalid or expired OTP', 400)

  const users = await findAuthUsersByLoginId(loginId)
  if (users.length !== 1) return invalid()
  const user = users[0]

  const reset = await findActiveOtpReset(user.id, user.tenantId)
  if (!reset || reset.attempts >= MAX_OTP_ATTEMPTS) return invalid()

  if (otpHash(user.id, otp) !== reset.otpHash) {
    await bumpResetAttempts(reset.id)
    return invalid()
  }

  const resetToken = generateOpaqueToken()
  await markOtpVerified(reset.id, hashToken(resetToken), RESET_TOKEN_TTL_MIN)
  return success(res, { resetToken })
}

// API 3: naya password
export async function resetPassword(req, res) {
  const { resetToken, newPassword } = req.validated.body

  const reset = await consumeResetToken(hashToken(resetToken)) // yahin token use ho jata hai
  if (!reset) return fail(res, 'Session expired. Please request a new OTP.', 400)

  try {
    const nextHash = await bcrypt.hash(newPassword, BCRYPT_COST)
    await updatePasswordHash(reset.userId, reset.tenantId, nextHash)
    await revokeAllForUser(reset.userId, reset.tenantId) // sab devices logout

    const user = await findAuthUserById(reset.userId, reset.tenantId)
    if (user) {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown'
      await clearLoginFailures(user.email, ip)
    }
  } catch (err) {
    return failFromError(res, err)
  }

  return success(res, { reset: true })
}