# Sync Push — Product Price Update (POS Items Rate → Cloud)

## Decision: Policy A (branch product row)

Catalog is already **per-branch** (`products.branch_id` from migration `012_branch_scoped_inventory.sql`).  
Wah Branch Manager changing Items Rate updates **that branch’s product row** `selling_price` — not a separate override table.

| Option | Choice | Why |
|--------|--------|-----|
| **A. Tenant/branch master on `products.selling_price`** | **Selected** | Matches current schema; IM Product Management reads this column; pull maps `price` ← `sellingPrice`. |
| B. Branch override table | Not needed | Would duplicate `012` branch-scoped products. |
| C. Both | Not needed | Extra complexity with no schema benefit today. |

## Final Price

Cloud UI **Final Price** is computed (not stored):

```
finalPrice = round(
  selling_price
  × (1 − discount_percent/100)
  × (1 − offer.percent/100)
  × (1 + Σ tax.rate_percent/100)
, 2)
```

After POS push updates `selling_price` (+ optional `discount_percent`), Product Management recalculates Final Price on read. No separate final-price column write.

## Conflict policy (Last-Write-Wins)

1. **Idempotent** by `(tenant_id, clientEventId)` — duplicate push → `skipped: true`, no double effects.
2. **Branch lock** — JWT / body `branchId` must match product `branch_id` (same as sale push). Payload `branchId` if present must equal the resolved push branch.
3. **LWW** — An accepted `product_price_update` **overwrites** cloud `selling_price` for that product. Concurrent IM edit loses if POS sync arrives later.
4. **Optional stale guard** — If payload includes `updatedAt` and cloud `products.updated_at` is **strictly newer**, the event is accepted into `pos_sync_events` but **skipped** (no overwrite), with `skipped: true` and reason in handler result. Omit `updatedAt` to always apply (default POS behaviour).

## Event contract

`POST /api/sync/push` (existing), Bearer JWT with `sync:push`.

Canonical `eventType`: **`product_price_update`**  
Alias also accepted: **`price_change`**

```json
{
  "deviceId": "<pos-device-uuid>",
  "branchId": "<branch-uuid>",
  "events": [
    {
      "clientEventId": "pos-price-<productId>-<timestamp>",
      "eventType": "product_price_update",
      "payload": {
        "productId": "<uuid>",
        "branchId": "<uuid>",
        "sellingPrice": 100,
        "discountPercent": 0,
        "currency": "PKR",
        "updatedAt": "2026-09-06T18:00:00.000Z",
        "updatedByUserId": "<uuid>",
        "source": "pos_items_rate",
        "deviceId": "<pos-device-uuid>"
      }
    }
  ]
}
```

### Aliases (camelCase / snake_case)

| Field | Aliases |
|-------|---------|
| productId | `product_id`, `id` |
| sellingPrice | `selling_price`, `price` |
| discountPercent | `discount_percent`, `discount` |
| branchId | `branch_id` |
| updatedAt | `updated_at` |
| updatedByUserId | `updated_by_user_id` |

### Response (unchanged envelope)

```json
{
  "success": true,
  "data": {
    "accepted": ["pos-price-..."],
    "rejected": [],
    "events": [
      {
        "clientEventId": "pos-price-...",
        "skipped": false,
        "productId": "<uuid>",
        "sellingPrice": 100,
        "saleId": null
      }
    ],
    "acceptedCount": 1
  },
  "error": null
}
```

HTTP **202**.

## Side effects

1. Upsert audit row in `pos_sync_events`.
2. `UPDATE products SET last_selling_price` (snapshot if changed), `selling_price`, optional `discount_percent`, `updated_at = now()`.
3. Delta pull (`GET /api/sync/delta?since=...`) returns the product because filter uses `updated_at` (migration `013_products_updated_at.sql`).

## Outbox note for POS

Prefer queuing **`product_price_update`** (not only `cashier_log` with `action: price_change`).  
`cashier_log` remains audit-only and does **not** write catalog prices.
