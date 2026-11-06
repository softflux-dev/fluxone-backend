# FluxOne Inventory API

Express + PostgreSQL (**raw SQL** via `pg`). ESM (`"type": "module"`).

## Quick start

```bash
cd server
npm install
# Copy .env.example → .env and fill values (never commit .env)
npm run migrate
npm run seed
npm run dev
```

| Script | Command |
|--------|---------|
| Dev server | `npm run dev` |
| Production start | `npm run start` |
| Schema (prod path) | `npm run migrate` → `database/migrate.js` |
| Demo data | `npm run seed` → `database/seeds/dummy_data.sql` only |

Health check: `GET /api/health` → `{ success, data, error }`.

Boot also runs migrations after a successful DB connection (`index.js`).

## Docs (start here)

| Doc | Purpose |
|-----|---------|
| [docs/HANDOVER.md](./docs/HANDOVER.md) | Junior day-one: stack, auth sessions, logging, out-of-scope rules |
| [docs/MODULE_MAP.md](./docs/MODULE_MAP.md) | HTTP prefix → real folder → entry routes |
| [docs/SYNC_FLOW.md](./docs/SYNC_FLOW.md) | POS sync: push / bootstrap / delta + file roles |

Coming later in handover: `database/SCHEMA.md`, learning dump `database/fluxone.sql` (not wired into seed; prod schema stays migrations).

## API mounts

`/api/auth` · `/api/inventory` · `/api/branch` · `/api/sync` · `/api/admin` · `/api/notifications`

See `src/app.js` and `docs/MODULE_MAP.md`.
