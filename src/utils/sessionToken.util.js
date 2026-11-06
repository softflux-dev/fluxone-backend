import crypto from 'crypto'

const DAY_MS = 86_400_000

// SHA-256 hex — store only this, never the raw opaque token.
export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

// Constant-time compare for equal-length hex hashes.
export function hashesEqual(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8')
  const right = Buffer.from(String(b || ''), 'utf8')
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

// High-entropy opaque secret shown once to the client.
export function generateOpaqueToken() {
  return crypto.randomBytes(32).toString('base64url')
}

export function newSessionId() {
  return crypto.randomUUID()
}

function envPositiveInt(name, fallback) {
  const n = Number(process.env[name])
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

export function getSessionTtlDays() {
  return envPositiveInt('SESSION_TTL_DAYS', 14)
}

export function getSessionAbsoluteDays() {
  return envPositiveInt('SESSION_ABSOLUTE_DAYS', 30)
}

// Sliding on when unset or anything other than "false".
export function isSessionSlidingEnabled() {
  const raw = String(process.env.SESSION_SLIDING ?? 'true').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'no'
}

// Extend when remaining lifetime is below this many days (default 7).
export function getSessionSlidingRemainingDays() {
  return envPositiveInt('SESSION_SLIDING_REMAINING_DAYS', 7)
}

export function buildSessionExpiryDates(now = new Date()) {
  const createdAt = now instanceof Date ? now : new Date(now)
  const ttlMs = getSessionTtlDays() * DAY_MS
  const absoluteMs = getSessionAbsoluteDays() * DAY_MS
  const expiresAt = new Date(createdAt.getTime() + ttlMs)
  const absoluteExpiresAt = new Date(createdAt.getTime() + absoluteMs)
  // Cap sliding window so it never exceeds absolute max.
  if (expiresAt.getTime() > absoluteExpiresAt.getTime()) {
    return { createdAt, expiresAt: absoluteExpiresAt, absoluteExpiresAt }
  }
  return { createdAt, expiresAt, absoluteExpiresAt }
}

export function secondsUntil(date) {
  const ms = new Date(date).getTime() - Date.now()
  return Math.max(0, Math.floor(ms / 1000))
}

// Next expires_at if sliding should run; null if no change.
export function computeSlidingExpiresAt(session, now = new Date()) {
  if (!isSessionSlidingEnabled()) return null
  if (!session?.expiresAt || !session?.absoluteExpiresAt) return null

  const nowMs = now.getTime()
  const expiresMs = new Date(session.expiresAt).getTime()
  const absoluteMs = new Date(session.absoluteExpiresAt).getTime()
  if (!(expiresMs > nowMs) || !(absoluteMs > nowMs)) return null

  const remainingMs = expiresMs - nowMs
  const thresholdMs = getSessionSlidingRemainingDays() * DAY_MS
  if (remainingMs >= thresholdMs) return null

  const nextMs = Math.min(nowMs + getSessionTtlDays() * DAY_MS, absoluteMs)
  if (nextMs <= expiresMs) return null
  return new Date(nextMs)
}

// Short label from User-Agent for audit / Phase 6 UI.
export function deviceLabelFromUserAgent(userAgent) {
  if (!userAgent) return null
  const ua = String(userAgent).slice(0, 180)
  if (/Electron/i.test(ua)) return 'POS / Electron'
  if (/Edg\//i.test(ua)) return 'Edge'
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return 'Chrome'
  if (/Firefox\//i.test(ua)) return 'Firefox'
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'Safari'
  return ua.slice(0, 64)
}