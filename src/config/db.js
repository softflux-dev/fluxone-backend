import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config()

const { Pool } = pg

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('Missing required environment variable: DATABASE_URL')
}

const isSupabase =
  databaseUrl.includes('supabase.co') || databaseUrl.includes('supabase.com')

export const pool = new Pool({
  connectionString: databaseUrl,
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  allowExitOnIdle: false,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  ssl: isSupabase ? { rejectUnauthorized: false } : undefined,
})

let keepAliveTimer = null

function startPoolKeepAlive() {
  if (keepAliveTimer) return
  keepAliveTimer = setInterval(() => {
    pool.query('SELECT 1').catch(() => {
      // ignore — next real query will reconnect
    })
  }, 30_000)
  keepAliveTimer.unref?.()
}

// Prefer pool.query for one-shot reads/writes (avoids manual connect/release).
export async function query(text, params = []) {
  try {
    return await pool.query(text, params)
  } catch (error) {
    console.error('Query error:', error)
    throw error
  }
}

export async function testConnection(retries = 3, delayMs = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query('SELECT 1')
      console.log('Database connection established successfully.')
      startPoolKeepAlive()
      return
    } catch (error) {
      console.error(
        `Database connection attempt ${attempt}/${retries} failed:`,
        error.message,
      )
      if (attempt === retries) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

export async function withTransaction(work) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    const summary =
      result && typeof result === 'object' && 'id' in result
        ? { id: result.id, name: result.name, status: result.status }
        : result
    console.log('Transaction successful:', summary)
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Transaction error:', error)
    throw error
  } finally {
    client.release()
  }
}

export function requireTenantId(tenantId) {
  if (!tenantId) {
    const error = new Error('tenant_id is required — refusing unscoped query')
    error.status = 403
    throw error
  }
  return tenantId
}

export async function tenantQuery(tenantId, text, params = []) {
  const scopedTenantId = requireTenantId(tenantId)
  return query(text, [scopedTenantId, ...params])
}

export async function tenantClientQuery(client, tenantId, text, params = []) {
  const scopedTenantId = requireTenantId(tenantId)
  return client.query(text, [scopedTenantId, ...params])
}
