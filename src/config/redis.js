import Redis from 'ioredis'

// Optional Redis — rate limits + auth lockout fall back when unset / down
let redis = null
let redisReady = false

const redisUrl = process.env.REDIS_URL || process.env.REDIS_URI || ''

if (redisUrl) {
  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: true,
  })

  redis.on('error', (err) => {
    redisReady = false
    console.warn('[redis] connection error:', err.message)
  })

  redis.on('ready', () => {
    redisReady = true
    console.log('[redis] connected')
  })

  redis.on('end', () => {
    redisReady = false
  })

  // Connect in background — do not block API boot
  redis.connect().catch((err) => {
    redisReady = false
    console.warn('[redis] connect failed, using in-memory fallbacks:', err.message)
  })
} else {
  console.warn('[redis] REDIS_URL not set — rate limits / lockout use in-memory stores')
}

// Client when REDIS_URL is configured (may still be connecting)
export function getRedisClient() {
  return redis
}

// Only when commands are safe to rely on
export function getRedis() {
  return redisReady && redis ? redis : null
}

export function isRedisReady() {
  return Boolean(redisReady && redis)
}

export { redis }
