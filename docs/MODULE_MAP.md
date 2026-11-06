# FluxOne Inventory Server — Module Map

Maps **HTTP prefixes** to **physical folders**. Logical names used in conversation (`inventory`, `branch`, `admin`) are **not** folder renames — they map as follows:

| Logical name | Real folder |
|--------------|-------------|
| auth | `src/modules/auth` |
| inventory | `src/modules/inventory-manager` |
| branch | `src/modules/branch-manager` |
| admin | `src/modules/b2b-admin` |
| sync | `src/modules/sync` |
| notifications | `src/modules/notifications` |

Do **not** rename these folders unless a later handover prompt explicitly allows Phase-B moves.

Request shape inside a feature: `routes → validator → controller → model (raw SQL)`.

---

## Top-level mounts

| HTTP prefix | Primary roles | Real folder path | Entry routes file | Notes |
|-------------|---------------|------------------|-------------------|-------|
| `/api/health` | any (unauthenticated) | `src/app.js` | inline `GET` | `{ success, data, error }` — DB `SELECT 1` |
| `/api/auth` | all roles (login / session) | `src/modules/auth` | `auth.routes.js` | Opaque `auth_sessions`; no refresh tokens |
| `/api/inventory` | inventory_manager (+ shared perms) | `src/modules/inventory-manager` | `inventory.routes.js` | Aggregates IM sub-routers |
| `/api/branch` | branch_manager / branch_admin (+ shared) | `src/modules/branch-manager` | `branch.routes.js` | **Large aggregator by design — do not split** |
| `/api/sync` | cashier / POS sync perms | `src/modules/sync` | `sync.routes.js` | push, bootstrap, delta, sales, events; `/pull` deprecated but kept |
| `/api/admin` | b2b_admin | `src/modules/b2b-admin` | `admin.routes.js` | `requireRoles(B2B_ADMIN)` on all admin routes |
| `/api/notifications` | authenticated user (own rows) | `src/modules/notifications` | `notifications.routes.js` | In-app notifications only |

---

## Auth

| HTTP prefix | Role | Real folder path | Entry routes file | Notes |
|-------------|------|------------------|-------------------|-------|
| `/api/auth` | public login; session for me/logout-all | `src/modules/auth` | `auth.routes.js` | Controllers + `auth_sessions.model.js`; validators in `auth.validator.js` |

---

## Inventory (logical) → `inventory-manager`

Entry: `inventory.routes.js` mounts the rows below under `/api/inventory`.

| HTTP prefix | Role | Real folder path | Entry routes file | Notes |
|-------------|------|------------------|-------------------|-------|
| `/api/inventory/dashboard` | IM / shared | `.../inventory-manager/dashboard` | `dashboard.routes.js` | IM dashboard |
| `/api/inventory/products` | IM / shared | `.../inventory-manager/products` | `product.routes.js` | Products, variants, bundles, import/export |
| `/api/inventory/control` | IM / shared | `.../inventory-manager/control` | `control.routes.js` | Stock control / price layers |
| `/api/inventory/suppliers` | IM / shared | `.../inventory-manager/suppliers` | `supplier.routes.js` | Suppliers |
| `/api/inventory/purchase-orders` | IM / shared | `.../inventory-manager/purchase-orders` | `purchase_order.routes.js` | POs + invoices |
| `/api/inventory/reports` | IM / shared | `.../inventory-manager/reports` | `report.routes.js` | Reports |
| `/api/inventory/lookups` | IM / shared | `.../inventory-manager/lookups` | `lookup.routes.js` | Lookup helpers |

---

## Branch (logical) → `branch-manager`

Entry: **`branch.routes.js`** — intentional fat file. Some areas use nested `*.routes.js`; many endpoints (attendance, holidays, leaves, sales, discounts, stock requests, performance, hardware/variants, etc.) are registered **directly** on `branch.routes.js`.

**Do not split `branch.routes.js`** as part of handover cleanup. Optional future Phase-B only if a later prompt says so.

| HTTP prefix | Role | Real folder path | Entry routes file | Notes |
|-------------|------|------------------|-------------------|-------|
| `/api/branch` (root aggregator) | BM / BA / shared | `src/modules/branch-manager` | **`branch.routes.js`** | Giant aggregator — **keep as-is** |
| `/api/branch/dashboard` | BM / shared | `.../branch-manager/dashboard` | `dashboard.routes.js` | Mounted via aggregator |
| `/api/branch/staff` | BM / shared | `.../branch-manager/staff` | `staff.routes.js` | HTTP `createStaff` handler kept; model uses `createStaffUser` |
| `/api/branch/designations` | BM / shared | `.../branch-manager/designations` | `designation.routes.js` | Designations |
| `/api/branch/activity-logs` | BM / shared | `.../branch-manager/activity-logs` | `activity_logs.routes.js` | Branch-isolated views over `activity_logs` |
| `/api/branch/attendance` | BM / shared | `.../branch-manager/attendance` | (wired in `branch.routes.js`) | List + mark |
| `/api/branch/holidays` | BM / shared | `.../branch-manager/holidays` | (wired in `branch.routes.js`) | CRUD |
| `/api/branch/leaves` (+ `/leaves/me`) | BM / shared | `.../branch-manager/leaves` | (wired in `branch.routes.js`) | Staff + BM self leave |
| `/api/branch/sales` | BM / shared | `.../branch-manager/sales` | (wired in `branch.routes.js`) | Sales / refund |
| `/api/branch` discounts / stock-requests / performance / hardware / scales / variants | BM / shared | `.../discounts`, `stock`, `performance`, `resources` | (wired in `branch.routes.js`) | Controllers live in subfolders; routes stay on aggregator |

---

## Admin (logical) → `b2b-admin`

Entry: `admin.routes.js` under `/api/admin` (B2B Admin only).

| HTTP prefix | Role | Real folder path | Entry routes file | Notes |
|-------------|------|------------------|-------------------|-------|
| `/api/admin/dashboard` | b2b_admin | `.../b2b-admin/dashboard` | `dashboard.routes.js` | Admin dashboard |
| `/api/admin/branches` | b2b_admin | `.../b2b-admin/branches` | `branches.routes.js` | Branch management |
| `/api/admin/leaves` | b2b_admin | `.../b2b-admin/leaves` | `leaves.routes.js` | BM leave inbox; decision → **notifications** (no leave-decision email) |
| `/api/admin/company` | b2b_admin | `.../b2b-admin/company` | `company.routes.js` | Company profile |
| `/api/admin/policies` | b2b_admin | `.../b2b-admin/policies` | `policies.routes.js` | Policies |
| `/api/admin/tax-profit` | b2b_admin | `.../b2b-admin/tax-profit` | `tax-profit.routes.js` | Tax / profit settings |
| `/api/admin/settings` | b2b_admin | `.../b2b-admin/settings` | `settings.routes.js` | Settings |
| `/api/admin/invoices` | b2b_admin | `.../b2b-admin/invoices` | `invoices.routes.js` | Invoices |
| `/api/admin/logs` | b2b_admin | `.../b2b-admin/logs` | `logs.routes.js` | Filtered admin activity UI; uses admin activity logging helpers |

---

## Sync

Most important operational module for POS offline. Full junior walkthrough: [`SYNC_FLOW.md`](./SYNC_FLOW.md).

| HTTP prefix | Role | Real folder path | Entry routes file | Notes |
|-------------|------|------------------|-------------------|-------|
| `/api/sync/push` | sync:push | `src/modules/sync` | `sync.routes.js` | Upload offline mutations (incl. activity → `activity_logs`) |
| `/api/sync/bootstrap` | sync:pull | same | same | Preferred full bootstrap |
| `/api/sync/delta` | sync:pull | same | same | Preferred incremental pull |
| `/api/sync/sales` | sync:pull | same | same | Sales pull |
| `/api/sync/events` | sync:pull | same | same | Events pull |
| `/api/sync/pull` | sync:pull | same | same | **Deprecated compatibility** — prefer bootstrap/delta; **do not change behavior** in handover |

Supporting files (same folder): `sync.controller.js`, `sync.validator.js`, `sync.model.js`, `sync.mapper.js`, `sync.access.js`, `sync.errors.js`, POS contract helpers.

---

## Notifications

| HTTP prefix | Role | Real folder path | Entry routes file | Notes |
|-------------|------|------------------|-------------------|-------|
| `/api/notifications` | authenticated (own) | `src/modules/notifications` | `notifications.routes.js` | List, unread count, mark read, delete |

Used for in-app flows such as leave decisions (email path removed).

---

## Shared utilities juniors will hit often

| Path | Role |
|------|------|
| `src/utils/activityLog.util.js` | Core `activity_logs` writer |
| `src/utils/adminActivityLog.util.js` | Admin mutation audit helpers / wrapper |
| `src/middlewares/auth.middleware.js` | Session auth |
| `src/middlewares/role.middleware.js` | Roles / permissions |
| `src/middlewares/validate.middleware.js` | Zod bridge |
| `src/config/db.js` | `pg` pool + tenant helpers |
| `src/config/redis.js` | Optional Redis for rate-limit / lockout |

---

## Explicit non-goals for this map

- No recommendation to split `branch.routes.js`
- No physical folder renames
- No migration renumbering
- Sync `/pull` stays until product asks otherwise
