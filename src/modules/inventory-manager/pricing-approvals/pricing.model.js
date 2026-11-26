import { tenantClientQuery, tenantQuery, withTransaction } from '../../../config/db.js'
import {
  notifyPriceApprovalResolved,
  notifyPosPriceSuperseded,
} from '../../notifications/notifications.service.js'
import { broadcastSyncRequired } from '../../sync/syncHub.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

// Record a POS price change (pending). Called from sync ingest inside its transaction.
export async function recordPosPriceChange(client, tenantId, row) {
  await tenantClientQuery(
    client,
    tenantId,
    `
      INSERT INTO pos_price_changes
        (tenant_id, branch_id, product_id, old_price, new_price, changed_by_user_id,
         changed_by_name, device_id, client_event_id, changed_at, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `,
    [
      row.branchId,
      row.productId,
      row.oldPrice,
      row.newPrice,
      row.changedByUserId || null,
      row.changedByName || null,
      row.deviceId || null,
      row.clientEventId || null,
      row.changedAt || new Date().toISOString(),
      row.status || 'pending',
    ],
  )
}

// A newer IM/cloud price wins (Last Write Wins): older pending POS changes are superseded, IM + BM told.
export async function supersedePendingPriceChanges(
  client,
  tenantId,
  { productId, branchId, newPrice },
) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      UPDATE pos_price_changes
      SET status = 'superseded', resolved_at = now()
      WHERE tenant_id = $1 AND product_id = $2 AND status = 'pending'
        AND ($3::uuid IS NULL OR branch_id = $3)
      RETURNING branch_id AS "branchId", new_price AS "posPrice"
    `,
    [productId, branchId || null],
  )
  if (!rows.length) return
  const { rows: p } = await tenantClientQuery(
    client,
    tenantId,
    `SELECT name, variant_label AS "variantLabel" FROM products WHERE tenant_id = $1 AND id = $2`,
    [productId],
  )
  const productName = [p[0]?.name, p[0]?.variantLabel].filter(Boolean).join(' - ')
  const byBranch = new Map(rows.map((r) => [r.branchId, r]))
  for (const [bId, r] of byBranch) {
    ;(client.afterCommit ||= []).push(() =>
      notifyPosPriceSuperseded(tenantId, {
        branchId: bId,
        productId,
        productName,
        posPrice: Number(r.posPrice),
        newPrice: Number(newPrice),
      }),
    )
  }
}

// One row per product + branch: earliest old price -> latest new price, with sales in that window.
export async function listApprovals(tenantId, { branchId, status = 'pending' }) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      WITH grp AS (
        SELECT pc.product_id, pc.branch_id,
               (array_agg(pc.id ORDER BY pc.changed_at DESC))[1] AS id,
               (array_agg(pc.old_price ORDER BY pc.changed_at ASC))[1] AS old_price,
               (array_agg(pc.new_price ORDER BY pc.changed_at DESC))[1] AS new_price,
               (array_agg(pc.changed_by_name ORDER BY pc.changed_at DESC))[1] AS changed_by,
               (array_agg(pc.device_id ORDER BY pc.changed_at DESC))[1] AS device_id,
               MIN(pc.changed_at) AS first_changed_at,
               MAX(pc.changed_at) AS changed_at,
               MAX(pc.resolved_at) AS resolved_at,
               COUNT(*) AS change_count
        FROM pos_price_changes pc
        WHERE pc.tenant_id = $1 AND pc.status = $3
          AND ($2::uuid IS NULL OR pc.branch_id = $2)
        GROUP BY pc.product_id, pc.branch_id
      )
      SELECT g.id, g.product_id AS "productId", g.branch_id AS "branchId",
             p.name, p.variant_label AS "variantLabel", p.item_code AS "itemCode",
             p.image_url AS "imageUrl",
             g.old_price AS "oldPrice", g.new_price AS "newPrice",
             g.changed_by AS "changedBy", g.device_id AS "deviceId",
             g.first_changed_at AS "firstChangedAt", g.changed_at AS "changedAt",
             g.change_count::int AS "changeCount",
             COALESCE(sales.qty, 0) AS "unitsSold",
             COALESCE(sales.cnt, 0)::int AS "salesCount"
      FROM grp g
      JOIN products p ON p.id = g.product_id AND p.tenant_id = $1
      LEFT JOIN LATERAL (
        SELECT SUM(si.quantity) AS qty, COUNT(DISTINCT s.id) AS cnt
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id AND si.tenant_id = s.tenant_id
        WHERE s.tenant_id = $1 AND s.branch_id = g.branch_id AND si.product_id = g.product_id
          AND s.sold_at >= g.first_changed_at
          AND (g.resolved_at IS NULL OR s.sold_at < g.resolved_at)
      ) sales ON true
      ORDER BY g.changed_at DESC
    `,
    [branchId || null, status],
  )
  return rows
}

// Bulk approve/reject by representative ids. Approve keeps the live price; reject reverts it immediately.
export async function resolveApprovals(tenantId, { ids, action, userId, branchId }) {
  return withTransaction(async (client) => {
    const done = []
    for (const id of ids) {
      const { rows } = await tenantClientQuery(
        client,
        tenantId,
        `SELECT product_id AS "productId", branch_id AS "branchId" FROM pos_price_changes
         WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
           AND ($3::uuid IS NULL OR branch_id = $3)`,
        [id, branchId || null],
      )
      if (!rows[0]) continue
      const { productId, branchId: bId } = rows[0]
      const { rows: grp } = await tenantClientQuery(
        client,
        tenantId,
        `SELECT old_price AS "oldPrice", new_price AS "newPrice" FROM pos_price_changes
         WHERE tenant_id = $1 AND product_id = $2 AND branch_id = $3 AND status = 'pending'
         ORDER BY changed_at ASC`,
        [productId, bId],
      )
      const originalPrice = Number(grp[0].oldPrice)
      const posPrice = Number(grp[grp.length - 1].newPrice)
      const status = action === 'approve' ? 'approved' : 'rejected'
      await tenantClientQuery(
        client,
        tenantId,
        `UPDATE pos_price_changes SET status = $4, resolved_by = $5, resolved_at = now()
         WHERE tenant_id = $1 AND product_id = $2 AND branch_id = $3 AND status = 'pending'`,
        [productId, bId, status, userId || null],
      )
      if (action === 'reject') {
        await tenantClientQuery(
          client,
          tenantId,
          `UPDATE products
           SET last_selling_price = selling_price, selling_price = $4::numeric, updated_at = now()
           WHERE tenant_id = $1 AND id = $2 AND branch_id = $3`,
          [productId, bId, originalPrice],
        )
      }
      const { rows: p } = await tenantClientQuery(
        client,
        tenantId,
        `SELECT name, variant_label AS "variantLabel" FROM products WHERE tenant_id = $1 AND id = $2`,
        [productId],
      )
      done.push({
        branchId: bId,
        productId,
        status,
        originalPrice,
        posPrice,
        productName: [p[0]?.name, p[0]?.variantLabel].filter(Boolean).join(' - '),
      })
    }
    if (!done.length) throw httpError(404, 'No pending price changes found')
    client.afterCommit = client.afterCommit || []
    for (const d of done) {
      client.afterCommit.push(() => notifyPriceApprovalResolved(tenantId, d))
      client.afterCommit.push(() => broadcastSyncRequired(tenantId, d.branchId, 'price_approval'))
    }
    return done
  })
}
