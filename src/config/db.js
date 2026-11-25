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
  // A fresh TLS+auth handshake to the remote pooler can take >10s on slow links;
  // keep warm connections around instead of dropping them every 10s.
  idleTimeoutMillis: 300_000,
  connectionTimeoutMillis: 30_000,
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
// Connect-phase failures never ran the statement, so one retry is safe.
const isConnectFailure = (e) =>
  /timeout exceeded when trying to connect|Connection terminated/i.test(e?.message || '')

export async function query(text, params = []) {
  try {
    try {
      return await pool.query(text, params)
    } catch (error) {
      if (!isConnectFailure(error)) throw error
      return await pool.query(text, params)
    }
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
  let destroy = false
  // a pooler drop between queries emits 'error' on a checked-out client; unhandled = process crash
  const onClientError = (err) => {
    destroy = true
    console.error('Transaction client error:', err.message)
  }
  client.on('error', onClientError)
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
    destroy = (await client.query('ROLLBACK').then(() => false, () => true)) || destroy
    console.error('Transaction error:', error)
    throw error
  } finally {
    // a dead connection must not go back into the pool
    if (!destroy) client.removeListener('error', onClientError)
    client.release(destroy)
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
