import { MOVEMENT_TYPES } from '../../../config/constants.js'
import { tenantClientQuery } from '../../../config/db.js'
import { httpError } from './product.shared.js'

// Recipe map: itemId → units required per 1 finished bundle
export function recipeQtyMap(bundleItems = []) {
  const map = new Map()
  for (const row of bundleItems) {
    if (!row?.itemId) continue
    map.set(String(row.itemId), Number(row.quantity) || 0)
  }
  return map
}

export async function loadBundleRecipe(client, tenantId, bundleId) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT item_id AS "itemId", quantity
      FROM bundle_items
      WHERE tenant_id = $1 AND bundle_id = $2
    `,
    [bundleId],
  )
  return rows
}

/**
 * Apply assemble / disassemble deltas via Control ledger (Stock Out / Stock In).
 * locked units for a component = finishedBundleQty × recipeQty
 *
 * insertLedgerEventInTx is injected so this module does not import control.model
 * (avoids a circular dependency with Product writes and Control Stock In).
 */
export async function applyBundleAssembleDelta(
  client,
  tenantId,
  {
    bundleId,
    bundleName,
    bundleScale = 'unit',
    oldBundleQty = 0,
    newBundleQty = 0,
    oldItems = [],
    newItems = [],
    createdBy = null,
    scopeBranchId = null,
    // Branch id for branch_inventory sync (Control Stock In always has this)
    branchId = null,
    // Extra fields on the finished-bundle ledger row (supplier, unitCost, sellingPrice, …)
    bundleLedgerExtras = {},
  },
  insertLedgerEventInTx,
) {
  if (typeof insertLedgerEventInTx !== 'function') {
    throw httpError(500, 'Bundle assemble requires a ledger writer')
  }

  const oldMap = recipeQtyMap(oldItems)
  const newMap = recipeQtyMap(newItems)
  const allIds = [...new Set([...oldMap.keys(), ...newMap.keys()])]
  const oldFinished = Math.max(0, Number(oldBundleQty) || 0)
  const newFinished = Math.max(0, Number(newBundleQty) || 0)
  // Prefer explicit branchId; fall back to scope for Product Management create/edit
  const ledgerBranchId = branchId || scopeBranchId || null

  if (allIds.length) {
    const { rows: componentRows } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT id, name, scale, quantity
        FROM products
        WHERE tenant_id = $1 AND id = ANY($2::uuid[])
        FOR UPDATE
      `,
      [allIds],
    )
    const byId = new Map(componentRows.map((row) => [String(row.id), row]))

    for (const itemId of allIds) {
      const component = byId.get(itemId)
      if (!component) throw httpError(404, 'Bundle component product not found')

      const oldLocked = oldFinished * (oldMap.get(itemId) || 0)
      const newLocked = newFinished * (newMap.get(itemId) || 0)
      const delta = newLocked - oldLocked
      if (delta === 0) continue

      if (delta > 0) {
        // Need more components locked into finished bundles → Stock Out component
        try {
          await insertLedgerEventInTx(client, tenantId, {
            productId: itemId,
            movementType: MOVEMENT_TYPES.OUT,
            quantity: delta,
            scale: component.scale || 'unit',
            reason: `Assembled into bundle: ${bundleName}`,
            createdBy,
            scopeBranchId,
            branchId: ledgerBranchId,
          })
        } catch (err) {
          // Surface which component blocked assemble (Control Stock In + Edit Bundle)
          if (err?.status === 422 || /insufficient stock/i.test(String(err?.message || ''))) {
            throw httpError(
              422,
              `Insufficient stock for "${component.name}" to assemble bundle "${bundleName}"`,
            )
          }
          throw err
        }
      } else {
        // Returning components from disassembled finished stock → Stock In component
        await insertLedgerEventInTx(client, tenantId, {
          productId: itemId,
          movementType: MOVEMENT_TYPES.IN,
          quantity: Math.abs(delta),
          scale: component.scale || 'unit',
          reason: `Returned from bundle: ${bundleName}`,
          createdBy,
          scopeBranchId,
          branchId: ledgerBranchId,
          // Internal assemble pass — do not re-enter bundle Stock-In assemble logic
          skipBundleAssemble: true,
        })
      }
    }
  }

  const finishedDelta = newFinished - oldFinished
  let bundleLedger = null

  if (finishedDelta > 0) {
    bundleLedger = await insertLedgerEventInTx(client, tenantId, {
      productId: bundleId,
      movementType: MOVEMENT_TYPES.IN,
      quantity: finishedDelta,
      scale: bundleScale || 'unit',
      reason: `Bundle assembled: ${bundleName}`,
      createdBy,
      scopeBranchId,
      branchId: ledgerBranchId,
      // Prevent re-entry when Control Stock In triggers assemble
      skipBundleAssemble: true,
      ...bundleLedgerExtras,
    })
  } else if (finishedDelta < 0) {
    bundleLedger = await insertLedgerEventInTx(client, tenantId, {
      productId: bundleId,
      movementType: MOVEMENT_TYPES.OUT,
      quantity: Math.abs(finishedDelta),
      scale: bundleScale || 'unit',
      reason: `Bundle disassembled: ${bundleName}`,
      createdBy,
      scopeBranchId,
      branchId: ledgerBranchId,
      skipBundleAssemble: true,
      ...bundleLedgerExtras,
    })
  }

  return bundleLedger
}
