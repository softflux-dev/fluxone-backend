import { getRedis } from '../config/redis.js'

// In-memory fallback when Redis is unavailable (single-process only)
const memory = new Map()

function lockKey(loginId, ip) {
  const id = String(loginId || '').trim().toLowerCase()
  return `auth:lock:${id}:${ip || 'unknown'}`
}

function failKey(loginId, ip) {
  const id = String(loginId || '').trim().toLowerCase()
  return `auth:fail:${id}:${ip || 'unknown'}`
}

// 5 failed attempts → lock; correct password also blocked until lock expires
function maxAttempts() {
  return Number(process.env.AUTH_LOCKOUT_MAX_ATTEMPTS || 5)
}

// Rolling window that counts failures toward the lock threshold
function windowSec() {
  return Math.ceil(Number(process.env.AUTH_LOCKOUT_WINDOW_MS || 15 * 60 * 1000) / 1000)
}

// Lock duration after max attempts (default 6 minutes)
function lockSec() {
  return Math.ceil(Number(process.env.AUTH_LOCKOUT_DURATION_MS || 6 * 60 * 1000) / 1000)
}

function memGet(key) {
  const row = memory.get(key)
  if (!row) return null
  if (row.expiresAt <= Date.now()) {
    memory.delete(key)
    return null
  }
  return row.value
}

function memSet(key, value, ttlSec) {
  memory.set(key, { value, expiresAt: Date.now() + ttlSec * 1000 })
}

function memIncr(key, ttlSec) {
  const current = Number(memGet(key) || 0) + 1
  memSet(key, current, ttlSec)
  return current
}

function memDel(key) {
  memory.delete(key)
}

export async function isLoginLocked(loginId, ip) {
  const key = lockKey(loginId, ip)
  const redis = getRedis()
  if (redis) {
    try {
      const ttl = await redis.ttl(key)
      if (ttl > 0) return { locked: true, retryAfterSec: ttl }
      if (ttl === -1) return { locked: true, retryAfterSec: lockSec() }
      return { locked: false, retryAfterSec: 0 }
    } catch {
      // fall through to memory
    }
  }

  const until = memGet(key)
  if (!until) return { locked: false, retryAfterSec: 0 }
  const retryAfterSec = Math.max(1, Math.ceil((Number(until) - Date.now()) / 1000))
  return { locked: true, retryAfterSec }
}

export async function recordLoginFailure(loginId, ip) {
  const fails = failKey(loginId, ip)
  const lock = lockKey(loginId, ip)
  const redis = getRedis()
  const window = windowSec()
  const max = maxAttempts()
  const lockFor = lockSec()

  if (redis) {
    try {
      const count = await redis.incr(fails)
      if (count === 1) await redis.expire(fails, window)
      if (count >= max) {
        await redis.set(lock, '1', 'EX', lockFor)
        await redis.del(fails)
        return { locked: true, attempts: count, retryAfterSec: lockFor }
      }
      return { locked: false, attempts: count, retryAfterSec: 0 }
    } catch {
      // fall through to memory
    }
  }

  const attempts = memIncr(fails, window)
  if (attempts >= max) {
    memSet(lock, Date.now() + lockFor * 1000, lockFor)
    memDel(fails)
    return { locked: true, attempts, retryAfterSec: lockFor }
  }
  return { locked: false, attempts, retryAfterSec: 0 }
}

export async function clearLoginFailures(loginId, ip) {
  const redis = getRedis()
  const keys = [failKey(loginId, ip), lockKey(loginId, ip)]
  if (redis) {
    try {
      await redis.del(...keys)
      return
    } catch {
      // fall through
    }
  }
  for (const key of keys) memDel(key)
}
