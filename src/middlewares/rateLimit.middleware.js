import rateLimit from 'express-rate-limit'
import { RedisStore } from 'rate-limit-redis'
import { getRedisClient } from '../config/redis.js'

const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000)

function createStore(prefix) {
  const client = getRedisClient()
  // No REDIS_URL → default memory store inside express-rate-limit
  if (!client) return undefined

  return new RedisStore({
    prefix: `rl:${prefix}:`,
    // ioredis queues commands until connected
    sendCommand: (...args) => client.call(...args),
  })
}

function createLimiter(max, message, prefix) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: createStore(prefix),
    // If Redis blips, prefer availability over hard 500s
    passOnStoreError: true,
    message: { success: false, data: null, error: message },
  })
}

// Global fallback for unmatched routes / health
export const globalLimiter = createLimiter(
  Number(process.env.RATE_LIMIT_GLOBAL_MAX || 300),
  'Too many requests. Please try again later.',
  'global',
)

// Strict limiter for login / logout / password endpoints
// Keep above AUTH_LOCKOUT_MAX_ATTEMPTS so lockout messages win over generic rate-limit text
export const authLimiter = createLimiter(
  Number(process.env.RATE_LIMIT_AUTH_MAX || 30),
  'Too many authentication attempts. Please try again later.',
  'auth',
)

// Inventory manager APIs (products, control, suppliers, POs, dashboard, reports)
export const inventoryLimiter = createLimiter(
  Number(process.env.RATE_LIMIT_INVENTORY_MAX || 200),
  'Too many inventory requests. Please try again later.',
  'inventory',
)

// Branch manager APIs
export const branchLimiter = createLimiter(
  Number(process.env.RATE_LIMIT_BRANCH_MAX || 150),
  'Too many branch requests. Please try again later.',
  'branch',
)

// POS sync push/pull — higher throughput for devices
export const syncLimiter = createLimiter(
  Number(process.env.RATE_LIMIT_SYNC_MAX || 400),
  'Too many sync requests. Please try again later.',
  'sync',
)

// B2B Admin APIs
export const adminLimiter = createLimiter(
  Number(process.env.RATE_LIMIT_ADMIN_MAX || 150),
  'Too many admin requests. Please try again later.',
  'admin',
)

// Notifications APIs (was global-only)
export const notificationsLimiter = createLimiter(
  Number(process.env.RATE_LIMIT_NOTIFICATIONS_MAX || 120),
  'Too many notification requests. Please try again later.',
  'notifications',
)


// 15 minutes in milliseconds. Used as the time window for every limiter below.
const FIFTEEN_MIN = 15 * 60 * 1000

// Builds the "key" that the limiter counts requests against.
// Every distinct key gets its own separate counter.
// - If the request body has a User ID, the key is based on that ID, so each
//   account is limited independently of every other account.
// - If there is no ID in the body, fall back to the client's IP address.
const idKey = (req) => {
  const id = String(req.body?.id || '').trim().toLowerCase()
  return id ? `id:${id}` : `ip:${ipKeyGenerator(req.ip)}`
}

// Max 5 requests per 15 minutes for each individual User ID.
export const forgotPasswordLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 5,
  keyGenerator: idKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many OTP requests for this User ID. Please try again after 15 minutes.',
  },

})
//  per IP, for "send OTP" requests.
// one IP from trying hundreds of different User IDs (spam / checking which IDs exist).
export const forgotPasswordIpLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests from this network. Please try again later.',
  },
  
})

//Max 10 verify requests per 15 minutes for each User ID.
// (Separately, the controller allows only 5 wrong guesses per OTP.)
export const verifyOtpLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 10,
  keyGenerator: idKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many attempts for this User ID. Please try again after 15 minutes.',
  },

})

//per IP, for "reset password" requests.
// The reset request body has no User ID (it only carries the resetToken),
// so we can't key by ID; we use the default IP key with a loose limit.
export const resetPasswordLimiter = rateLimit({
  windowMs: FIFTEEN_MIN,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please try again later.',
  },
})