# FluxOne Inventory Server — Junior Handover

Short guide for day-one orientation. Read this first, then `MODULE_MAP.md`, then code.

---

## Stack

| Piece | What we use |
|-------|-------------|
| Runtime | Node.js, **ESM** (`"type": "module"`) |
| HTTP | **Express** (`src/app.js`, entry `index.js`) |
| Database | **PostgreSQL** via **`pg` raw SQL** — no ORM |
| Cache / rate-limit | **Redis** optional (`REDIS_URL`); falls back to in-memory |
| Real-time | **Socket.io is not required** for the core API |
| Validation | Zod in `*.validator.js` |
| Email | NodeMailer (optional SMTP) |

Mental model for request flow:

```text
routes → validator → controller → model (SQL)
```

Physical folder names today may differ from the logical names (see `MODULE_MAP.md`). Do **not** rename folders unless a later handover prompt explicitly allows it.

---

## How to start (local)

From the `server/` directory:

```bash
npm install
# copy .env.example → .env and fill values (never commit secrets)
npm run migrate   # applies database/migrations/* in order
npm run seed      # loads database/seeds/dummy_data.sql only
npm run dev       # node --watch index.js
```

| Script | What it does |
|--------|----------------|
| `npm run dev` | Dev server with file watch |
| `npm run start` | Production-style `node index.js` |
| `npm run migrate` | `database/migrate.js` — **production schema path** |
| `npm run seed` | `database/seeds/seed.js` → **`dummy_data.sql` only** |

Notes:

- On boot, `index.js` also runs migrations after a successful DB connection.
- **Prod schema changes** = add a new migration + `npm run migrate` / boot migrate. Never rename, renumber, or reorder existing files under `database/migrations/`.
- A learning/local dump **`database/fluxone.sql`** (and guide) may be added later for table/FK exploration. It is **not** a replacement for migrations and must **not** be wired into `npm run seed`.

---

## Environment

Use **`server/.env.example`** as the key checklist. Do not paste real secrets into docs or commits.

Important groups (names only):

- **Server / CORS:** `PORT`, `NODE_ENV`, `CLIENT_ORIGIN`
- **Database:** `DATABASE_*` / `DATABASE_URL`
- **Sessions (opaque auth):** `SESSION_TTL_DAYS`, `SESSION_ABSOLUTE_DAYS`, `SESSION_SLIDING`, `SESSION_SLIDING_REMAINING_DAYS`
- **Rate limits:** `RATE_LIMIT_*`
- **Redis (optional):** `REDIS_URL`
- **Login lockout:** `AUTH_LOCKOUT_*`
- **Uploads / Cloudinary (optional):** `CLOUDINARY_*`
- **SMS / SMTP (optional):** `TWILIO_*`, `SMTP_*`

---

## Auth (sessions — not refresh tokens)

**Current app code uses opaque `auth_sessions` only.** There is no refresh-token login path in JS.

Migration history (do not rewrite):

| Migration | Meaning |
|-----------|---------|
| `033_refresh_tokens.sql` | Historical: created `refresh_tokens` |
| `053_auth_sessions.sql` | Creates `auth_sessions` (token hash, expiry, revoke, device meta) |
| `054_drop_refresh_tokens.sql` | Drops `refresh_tokens` after session cutover |

Related code: `src/modules/auth/`, `src/modules/auth/auth_sessions.model.js`, `src/utils/sessionToken.util.js`, `src/middlewares/auth.middleware.js`.

Do **not** reintroduce refresh-token tables or rotation code.

---

## API mounts (`src/app.js`)

| Prefix | Module folder (physical) |
|--------|---------------------------|
| `/api/health` | Inline in `app.js` (DB ping) |
| `/api/auth` | `modules/auth` |
| `/api/inventory` | `modules/inventory-manager` |
| `/api/branch` | `modules/branch-manager` |
| `/api/sync` | `modules/sync` |
| `/api/admin` | `modules/b2b-admin` |
| `/api/notifications` | `modules/notifications` |

Auth middleware + per-area rate limiters apply as configured in `app.js` (auth has its own limiter; most other mounts require a valid session).

---

## Response shape

All APIs should follow:

```json
{ "success": true, "data": { }, "error": null }
```

or on failure:

```json
{ "success": false, "data": null, "error": "Message" }
```

**Health** uses the same contract:

- OK: `{ success: true, data: { status: "ok" }, error: null }`
- DB down: HTTP 503 + `{ success: false, data: null, error: "Database unreachable" }`

Do not use a separate `{ status: true/false }` health shape.

---

## Logging (two systems — both stay)

| File | Purpose |
|------|---------|
| `src/utils/activityLog.util.js` | Core writer for **`activity_logs`**. Branch Manager branch-isolated activity views use this store. Cashier / POS activity often arrives via **sync** push and is written through this path. |
| `src/utils/adminActivityLog.util.js` | Wrapper helpers for **overall system mutation audits** (e.g. `writeAdminActivity`). The **B2B Admin Logs UI** (filters, categories) reads this admin-oriented activity data. |

Both are intentional. Do not delete one “to simplify.”

---

## Dead code already cleaned (Chat-1)

Juniors should not “restore” these:

- Model alias `export const createStaff = createStaffUser` removed from `staff.model.js`. Use **`createStaffUser`** in models.
- HTTP handler **`createStaff`** in `staff.controller.js` (and client RTK/hooks named `createStaff`) **remain** — that is the API surface, not dead code.
- Leave **decision email** path removed (`leave-decision.email.js`, `sendLeaveDecisionEmail`). Leave decisions notify via **in-app notifications** (`notifyBmOfLeaveDecision` / notifications service).

---

## Out of scope / do not touch without an explicit ask

- Splitting `branch.routes.js` (fat aggregator is **intentional for now**)
- Changing `GET /api/sync/pull` behavior (prefer `/bootstrap` + `/delta` for POS; `/pull` kept for compatibility)
- Renaming / renumbering / reordering `database/migrations/*`
- Wiring `fluxone.sql` into `npm run seed`
- Physical folder renames (`inventory-manager` → `inventory`, etc.)
- Committing `.env` / secrets

---

## Suggested reading order

1. This file (`docs/HANDOVER.md`)
2. `docs/MODULE_MAP.md` — where each HTTP prefix lives
3. `src/app.js` — mounts, health, middleware order
4. `modules/auth/` — login / session
5. `modules/sync/` + **`docs/SYNC_FLOW.md`** — POS offline sync (most important operational area)
6. One vertical end-to-end: e.g. `branch-manager/staff` or `inventory-manager/products` (`routes` → `validator` → `controller` → `model`)
7. `database/migrate.js` + a few recent migrations — how schema evolves
8. Later: `database/SCHEMA.md`, `database/FLUXONE_SQL_GUIDE.md` / `fluxone.sql` when those exist

---

## Docs index

| Doc | Status / role |
|-----|----------------|
| `docs/HANDOVER.md` | This file |
| `docs/MODULE_MAP.md` | HTTP ↔ folder map |
| `docs/SYNC_FLOW.md` | POS sync endpoints + file walkthrough |
| `database/SCHEMA.md` | Coming |
| `database/FLUXONE_SQL_GUIDE.md` / `fluxone.sql` | Coming — learning dump only |
