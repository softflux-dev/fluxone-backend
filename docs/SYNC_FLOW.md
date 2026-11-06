# Sync flow (POS ↔ cloud) — junior guide

Read after `HANDOVER.md` and `MODULE_MAP.md`. This doc explains **how** `/api/sync` works. Code lives in `src/modules/sync/`. **Do not change `GET /api/sync/pull` behavior** unless a later prompt explicitly asks.

---

## 1. Who calls sync

| Client | Role |
|--------|------|
| **FluxOne-POS / desktop cashier app** | Primary caller. Goes offline, queues sales/refunds/price/cashier logs, then **pushes** them. Pulls catalog + users via **bootstrap** (first / full) and **delta** (since last sync). |
| Branch-scoped staff using POS perms | Same endpoints; branch lock enforced in `sync.access.js`. |
| Tenant-wide admin (rare) | May list **events** across branches; still uses session auth. |

Sync is **not** the Admin React panel’s day-to-day CRUD. Web admin uses `/api/branch`, `/api/inventory`, `/api/admin`.

---

## 2. Auth + permissions

Mount (`src/app.js`):

```text
app.use('/api/sync', syncLimiter, authMiddleware, syncRoutes)
```

1. **Session required** — `authMiddleware` (opaque `auth_sessions`, not refresh tokens).
2. **Rate limit** — `syncLimiter` before the router.
3. **Permission per route** — `requirePermission(...)` in `sync.routes.js`:
   - `POST /push` → `sync:push`
   - All GET routes (`bootstrap`, `delta`, `sales`, `events`, `pull`) → `sync:pull`
4. **Branch lock** — cashiers / BM / IM / branch_admin may only sync **their** `branchId` (`sync.access.js`).

---

## 3. Endpoints (learn this order)

| Method | Path | Perm | Purpose |
|--------|------|------|---------|
| `POST` | `/api/sync/push` | `sync:push` | Upload offline events (sale, refund, price, `cashier_log`, …). HTTP **202** when body is valid; inspect `data.rejected[]` / `hasFailures`. |
| `GET` | `/api/sync/bootstrap` | `sync:pull` | Full branch snapshot for POS (products, users w/ offline hashes, policies, …). **Preferred** first sync. |
| `GET` | `/api/sync/delta` | `sync:pull` | Changes since `?since=` timestamp. **Preferred** incremental sync. |
| `GET` | `/api/sync/sales` | `sync:pull` | Paginated sale/invoice history for the branch (cloud → POS). |
| `GET` | `/api/sync/events` | `sync:pull` | Audit list of stored `pos_sync_events` (not the product catalog). |
| `GET` | `/api/sync/pull` | `sync:pull` | **Legacy.** Kept for compatibility. Today it delegates like `events` — **do not rewire** without an explicit ask. Prefer bootstrap + delta for catalog. |

Query/body shapes are validated in `sync.validator.js` (Zod).

---

## 4. Request path (mental model)

```text
HTTP
  → sync.routes.js          (path + permission)
  → sync.controller.js      (parse, call access, orchestrate)
  → sync.validator.js       (Zod / normalize payloads)
  → sync.access.js          (branchId + role lock)
  → sync.model.js           (raw SQL / transactions)
  → sync.mapper.js          (bootstrap/delta → POS field names)
  → sync.errors.js          (stable codes, rejected[] shape)
```

Contracts (POS team docs + field constants):

- `posOfflineAuth.contract.js` — offline login hashes on bootstrap/delta
- `posSlipPolicies.contract.js` — receipt slip policies on bootstrap/delta

Same pattern as the rest of the server: **routes → validator → controller → model (SQL)**.

---

## 5. What each file does

### `sync.routes.js`

- Wires Express paths to controller handlers.
- Applies `sync:push` / `sync:pull` permissions.
- Marks `/pull` as deprecated; leaves the route registered.
- **Read next:** `sync.controller.js`

### `sync.validator.js`

- Zod schemas for push body, bootstrap/delta/sales query, event payloads.
- Normalizers for POS JSON quirks (nulls, alternate field names).
- `parseSchemaOrThrow` → consistent validation errors for controllers.
- **Read next:** `sync.controller.js` (how schemas are used)

### `sync.controller.js`

- Thin HTTP layer: validate → resolve branch → call model → `success(...)`.
- `push`: per-event try/catch; builds `accepted` / `rejected` / `skipped` (always 202 if body OK).
- `bootstrap` / `delta`: snapshot + `mapSnapshotForPos`.
- `pull`: legacy handler — **do not change behavior**.
- **Read next:** `sync.model.js`, `sync.access.js`

### `sync.model.js`

- Raw SQL + transactions for ingest and snapshots.
- `ingestSyncEvent` routes event types (sale, refund, price, `cashier_log`, …).
- `buildBootstrapSnapshot` / `buildDeltaSnapshot` for catalog pulls.
- Writes cashier activity via `activityLog.util.js` (see §6).
- **Read next:** `sync.mapper.js` (response shape), `sync.errors.js` (failure codes)

### `sync.mapper.js`

- Maps cloud snapshot fields to names FluxOne-POS expects (sku/price, user email alias, etc.).
- Attaches slip policies + offline-auth related user fields.
- Re-exports contract field constants for POS docs alignment.
- **Read next:** `posOfflineAuth.contract.js`, `posSlipPolicies.contract.js`

### `sync.access.js`

- Resolves `branchId` for push vs pull vs events list.
- Enforces branch-locked roles (cannot sync another branch).
- Tenant-wide admin may filter events more broadly.
- **Read next:** `sync.controller.js` call sites

### `sync.errors.js`

- Stable `SYNC_ERROR_CODES` for POS retry / switch logic.
- Builds `rejected[]` entries (`code`, `reason`, `retryable`, `hint`, …).
- Helpers for request-level sync error JSON.
- **Read next:** `sync.controller.js` (`buildRejectedPushEvent`), `sync.model.js` throws

### `posOfflineAuth.contract.js`

- Documents how bootstrap/delta `users[]` carry bcrypt hashes for offline POS login.
- Field name constants (`POS_OFFLINE_AUTH_FIELDS`).
- Not an HTTP route — contract for desktop POS + mapper.
- **Read next:** `sync.mapper.js` (`mapUser`)

### `posSlipPolicies.contract.js`

- Documents slip / invoice policy fields on bootstrap/delta.
- Helpers to resolve and format print lines for receipts.
- **Read next:** `sync.mapper.js` (company.slipPolicies)

---

## 6. Where cashier activity logs land

```text
POS offline action
  → POST /api/sync/push  (eventType: cashier_log)
  → sync.controller push
  → sync.model ingestSyncEvent → ingestCashierLogEvent
  → logActivity(...) in activityLog.util.js
  → row in activity_logs  (source: 'pos', linked clientEventId / posEventId)
```

- Branch Manager **branch activity** UIs read **`activity_logs`** (same store).
- Event is also stored in **`pos_sync_events`** (idempotent on `clientEventId`).
- This is **not** `adminActivityLog.util.js` (that path is system / B2B Admin mutation audits). Both log systems stay — see `HANDOVER.md`.

---

## 7. Suggested code walk (30–45 min)

1. `sync.routes.js` — list endpoints  
2. `push` in `sync.controller.js` — accepted vs rejected  
3. `ingestSyncEvent` + `ingestCashierLogEvent` in `sync.model.js`  
4. `bootstrap` / `delta` + `mapSnapshotForPos`  
5. Skim `sync.errors.js` codes once  

Then try a local push/bootstrap with a cashier session if you have POS or Postman fixtures.
