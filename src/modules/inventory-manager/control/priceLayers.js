import { tenantClientQuery } from '../../../config/db.js'

// True = keep the old sell price until that quantity is gone (BM toggle OFF).
export async function shouldKeepExistingStockPrice(client, tenantId) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `SELECT price_requires_stock_utilized AS enabled FROM tenants WHERE id = $1 LIMIT 1`,
    [],
  )
  return rows[0]?.enabled !== false
}

async function loadProduct(client, tenantId, productId) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT
        quantity,
        selling_price AS "sellingPrice",
        purchase_price AS "purchasePrice"
      FROM products
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE
    `,
    [productId],
  )
  return rows[0] || null
}

async function layeredQty(client, tenantId, productId) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT COALESCE(sum(quantity_remaining), 0)::numeric AS qty
      FROM product_price_layers
      WHERE tenant_id = $1 AND product_id = $2
    `,
    [productId],
  )
  return Number(rows[0]?.qty) || 0
}

async function insertLayer(client, tenantId, productId, qty, sellingPrice, purchasePrice) {
  const amount = Number(qty)
  if (!(amount > 0)) return
  await tenantClientQuery(
    client,
    tenantId,
    `
      INSERT INTO product_price_layers (
        tenant_id, product_id, quantity_remaining, selling_price, purchase_price
      )
      VALUES ($1, $2, $3, $4, $5)
    `,
    [productId, amount, sellingPrice ?? 0, purchasePrice ?? null],
  )
}

// Merge into the newest open layer when the price matches so FIFO stays intact.
async function appendLayer(client, tenantId, productId, qty, sellingPrice, purchasePrice) {
  const amount = Number(qty)
  if (!(amount > 0)) return
  const sell = Number(sellingPrice) || 0
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT id, selling_price AS "sellingPrice"
      FROM product_price_layers
      WHERE tenant_id = $1 AND product_id = $2 AND quantity_remaining > 0
      ORDER BY created_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `,
    [productId],
  )
  const newest = rows[0]
  if (newest && Number(newest.sellingPrice) === sell) {
    await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE product_price_layers
        SET quantity_remaining = quantity_remaining + $3
        WHERE tenant_id = $1 AND id = $2
      `,
      [newest.id, amount],
    )
    return
  }
  await insertLayer(client, tenantId, productId, amount, sell, purchasePrice)
}

async function rewriteOpenLayers(client, tenantId, productId, sellingPrice, purchasePrice) {
  await tenantClientQuery(
    client,
    tenantId,
    `
      UPDATE product_price_layers
      SET
        selling_price = COALESCE($3::numeric, selling_price),
        purchase_price = COALESCE($4::numeric, purchase_price)
      WHERE tenant_id = $1 AND product_id = $2 AND quantity_remaining > 0
    `,
    [productId, sellingPrice ?? null, purchasePrice ?? null],
  )
  await tenantClientQuery(
    client,
    tenantId,
    `
      UPDATE products
      SET
        selling_price = COALESCE($3::numeric, selling_price),
        purchase_price = COALESCE($4::numeric, purchase_price)
      WHERE tenant_id = $1 AND id = $2
    `,
    [productId, sellingPrice ?? null, purchasePrice ?? null],
  )
}

async function promoteFrontPrice(client, tenantId, productId) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT selling_price AS "sellingPrice", purchase_price AS "purchasePrice"
      FROM product_price_layers
      WHERE tenant_id = $1 AND product_id = $2 AND quantity_remaining > 0
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `,
    [productId],
  )
  if (!rows[0]) return
  await tenantClientQuery(
    client,
    tenantId,
    `
      UPDATE products
      SET
        selling_price = $3,
        purchase_price = COALESCE($4::numeric, purchase_price)
      WHERE tenant_id = $1 AND id = $2
    `,
    [productId, rows[0].sellingPrice, rows[0].purchasePrice],
  )
}

async function consumeLayers(client, tenantId, productId, qty) {
  let left = Number(qty)
  if (!(left > 0)) return
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT id, quantity_remaining AS "quantityRemaining"
      FROM product_price_layers
      WHERE tenant_id = $1 AND product_id = $2 AND quantity_remaining > 0
      ORDER BY created_at ASC, id ASC
      FOR UPDATE
    `,
    [productId],
  )
  for (const layer of rows) {
    if (left <= 0) break
    const have = Number(layer.quantityRemaining) || 0
    const take = Math.min(have, left)
    await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE product_price_layers
        SET quantity_remaining = quantity_remaining - $3
        WHERE tenant_id = $1 AND id = $2
      `,
      [layer.id, take],
    )
    left -= take
  }
  await promoteFrontPrice(client, tenantId, productId)
}

// Cover stock that existed before layers were tracked, at the current product price.
async function seedUnlayered(client, tenantId, productId, product, uncovered) {
  const gap = Number(uncovered)
  if (!(gap > 0)) return
  await insertLayer(
    client,
    tenantId,
    productId,
    gap,
    product.sellingPrice ?? 0,
    product.purchasePrice ?? null,
  )
}

// delta > 0 adds a lot. delta < 0 sells or removes oldest-priced units first.
export async function applyPriceLayersForMovement(
  client,
  tenantId,
  { productId, delta, sellingPrice = null, purchasePrice = null },
) {
  const change = Number(delta) || 0
  if (!change || !productId) return

  const product = await loadProduct(client, tenantId, productId)
  if (!product) return

  const onHand = Number(product.quantity) || 0
  const layered = await layeredQty(client, tenantId, productId)
  const keepOld = await shouldKeepExistingStockPrice(client, tenantId)
  const nextSell = sellingPrice != null ? Number(sellingPrice) : Number(product.sellingPrice) || 0
  const nextBuy = purchasePrice != null ? Number(purchasePrice) : product.purchasePrice

  if (change > 0) {
    const previous = onHand - change
    await seedUnlayered(client, tenantId, productId, product, previous - layered)

    if (!keepOld && (sellingPrice != null || purchasePrice != null)) {
      await rewriteOpenLayers(client, tenantId, productId, sellingPrice, purchasePrice)
    }

    await appendLayer(client, tenantId, productId, change, nextSell, nextBuy)

    if (!keepOld && (sellingPrice != null || purchasePrice != null)) {
      await rewriteOpenLayers(client, tenantId, productId, sellingPrice, purchasePrice)
    } else if (previous <= 0) {
      await promoteFrontPrice(client, tenantId, productId)
    }
    return
  }

  const removed = Math.abs(change)
  const before = onHand + removed
  await seedUnlayered(client, tenantId, productId, product, before - layered)
  await consumeLayers(client, tenantId, productId, removed)
}
