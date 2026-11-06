import { tenantClientQuery, tenantQuery } from '../config/db.js'

function taxNameForRate(rate) {
  return `Sales Tax ${rate}%`
}

/**
 * Find an existing tax row at `taxPercent`, or create `Sales Tax {rate}%`.
 * @param {string} tenantId
 * @param {number|string} taxPercent
 * @param {import('pg').PoolClient|null} [client] — pass tx client when inside withTransaction
 * @returns {Promise<string|null>} tax id, or null when rate ≤ 0 / invalid (tax-exempt)
 */
export async function findOrCreateTaxByRate(tenantId, taxPercent, client = null) {
  const rate = Number(taxPercent)
  if (!Number.isFinite(rate) || rate < 0) return null
  if (rate === 0) return null

  const run = (text, params) =>
    client
      ? tenantClientQuery(client, tenantId, text, params)
      : tenantQuery(tenantId, text, params)

  const { rows: existing } = await run(
    `
      SELECT id
      FROM taxes
      WHERE tenant_id = $1
        AND rate_percent = $2::numeric
      ORDER BY name ASC, id ASC
      LIMIT 1
    `,
    [rate],
  )
  if (existing[0]?.id) return existing[0].id

  const { rows: created } = await run(
    `
      INSERT INTO taxes (tenant_id, name, rate_percent)
      VALUES ($1, $2, $3::numeric)
      RETURNING id
    `,
    [taxNameForRate(rate), rate],
  )
  return created[0]?.id || null
}
