import crypto from 'crypto'
import { tenantClientQuery, tenantQuery, withTransaction } from '../../../config/db.js'
import { ROLE_IDS, ROLES, BRANCH_STATUS } from '../../../config/constants.js'
import { normalizeImageUrl } from '../../../utils/uploadUrl.util.js'
import {
  displayRefSearchHex,
  normalizeSearchQuery,
} from '../../../utils/displayRef.util.js'
import { revokeForBranch } from '../../auth/auth_sessions.model.js'

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function mapPgUniqueViolation(err, message) {
  if (err?.code === '23505') {
    throw httpError(409, message)
  }
  throw err
}

//Readable temp password: meets login min length (8), easy to type once from email/logs.
export function generateTemporaryPassword(length = 12) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$'
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length]
  }
  return out
}

// Normalize PG TIME / Date / "HH:MM:SS" to HH:MM for API clients.
function formatTimeValue(value) {
  if (value == null || value === '') return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const hours = String(value.getUTCHours()).padStart(2, '0')
    const minutes = String(value.getUTCMinutes()).padStart(2, '0')
    return `${hours}:${minutes}`
  }
  const text = String(value).trim()
  const match = text.match(/^(\d{1,2}):(\d{2})/)
  if (!match) return null
  return `${match[1].padStart(2, '0')}:${match[2]}`
}

const FULL_WEEK_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

const branchSelect = `
  b.id,
  b.name,
  b.location,
  b.image_url AS "imageUrl",
  b.status,
  to_char(b.opening_time, 'HH24:MI') AS "openingTime",
  to_char(b.closing_time, 'HH24:MI') AS "closingTime",
  COALESCE(b.working_days, ARRAY[]::text[]) AS "workingDays",
  b.created_at AS "createdAt",
  u.id AS "managerUserId",
  u.full_name AS "managerName",
  u.email AS "managerEmail",
  u.phone AS "managerContact",
  u.other_phone AS "managerOtherContact",
  u.gender AS "managerGender",
  u.address AS "managerAddress",
  u.image_url AS "managerImageUrl",
  u.is_active AS "managerIsActive",
  COALESCE(u.credentials_emailed, false) AS "managerCredentialsEmailed",
  (
    SELECT count(*)::int
    FROM staff s
    WHERE s.tenant_id = b.tenant_id AND s.branch_id = b.id
  ) AS "totalStaff"
`

function mapBranchRow(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    location: row.location || '',
    image: normalizeImageUrl(row.imageUrl) || row.imageUrl || '',
    status: row.status || BRANCH_STATUS.OPEN,
    openingTime: formatTimeValue(row.openingTime),
    closingTime: formatTimeValue(row.closingTime),
    // Admin-defined branch calendar (staff days must stay within this set)
    workingDays: Array.isArray(row.workingDays) ? row.workingDays : [],
    createdAt: row.createdAt,
    totalStaff: row.totalStaff ?? 0,
    manager: row.managerUserId
      ? {
          id: row.managerUserId,
          name: row.managerName || '',
          email: row.managerEmail || '',
          contact: row.managerContact || '',
          otherContact: row.managerOtherContact || '',
          gender: row.managerGender || '',
          address: row.managerAddress || '',
          profileImage: normalizeImageUrl(row.managerImageUrl) || row.managerImageUrl || '',
          isActive: row.managerIsActive !== false,
          credentialsEmailed: Boolean(row.managerCredentialsEmailed),
        }
      : null,
  }
}

async function getBranchByIdInTx(client, tenantId, id) {
  const { rows } = await tenantClientQuery(
    client,
    tenantId,
    `
      SELECT ${branchSelect}
      FROM branches b
      LEFT JOIN users u
        ON u.tenant_id = b.tenant_id
       AND u.branch_id = b.id
       AND u.role_id = ${ROLE_IDS[ROLES.BRANCH_MANAGER]}
      WHERE b.tenant_id = $1 AND b.id = $2
      ORDER BY u.created_at ASC NULLS LAST
      LIMIT 1
    `,
    [id],
  )
  return mapBranchRow(rows[0] || null)
}

export async function listBranches(tenantId, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(filters.limit) || 50))
  const offset = (page - 1) * limit
  const q = normalizeSearchQuery(filters.q) || null
  // Hex from BRN-XXXXXXXX (or bare UUID fragment) for compact-id match
  const qHex = q ? displayRefSearchHex(q, 'BRN') : null
  const status = filters.status || null

  const { rows: countRows } = await tenantQuery(
    tenantId,
    `
      SELECT count(*)::int AS total
      FROM branches b
      WHERE b.tenant_id = $1
        AND ($2::text IS NULL OR b.status = $2)
        AND (
          $3::text IS NULL
          OR b.name ILIKE '%' || $3 || '%'
          OR b.id::text ILIKE '%' || $3 || '%'
          OR (
            $4::text IS NOT NULL
            AND REPLACE(LOWER(b.id::text), '-', '') ILIKE '%' || $4 || '%'
          )
          OR COALESCE(b.location, '') ILIKE '%' || $3 || '%'
          OR EXISTS (
            SELECT 1 FROM users u
            WHERE u.tenant_id = b.tenant_id
              AND u.branch_id = b.id
              AND u.role_id = ${ROLE_IDS[ROLES.BRANCH_MANAGER]}
              AND (
                u.full_name ILIKE '%' || $3 || '%'
                OR u.email ILIKE '%' || $3 || '%'
              )
          )
        )
    `,
    [status, q, qHex],
  )

  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        b.id,
        b.name,
        b.location,
        b.image_url AS "imageUrl",
        b.status,
        to_char(b.opening_time, 'HH24:MI') AS "openingTime",
        to_char(b.closing_time, 'HH24:MI') AS "closingTime",
        COALESCE(b.working_days, ARRAY[]::text[]) AS "workingDays",
        b.created_at AS "createdAt",
        u.id AS "managerUserId",
        u.full_name AS "managerName",
        u.email AS "managerEmail",
        u.phone AS "managerContact",
        u.other_phone AS "managerOtherContact",
        u.gender AS "managerGender",
        u.address AS "managerAddress",
        u.image_url AS "managerImageUrl",
        u.is_active AS "managerIsActive",
        COALESCE(u.credentials_emailed, false) AS "managerCredentialsEmailed",
        (
          SELECT count(*)::int
          FROM staff s
          WHERE s.tenant_id = b.tenant_id AND s.branch_id = b.id
        ) AS "totalStaff"
      FROM branches b
      LEFT JOIN LATERAL (
        SELECT *
        FROM users um
        WHERE um.tenant_id = b.tenant_id
          AND um.branch_id = b.id
          AND um.role_id = ${ROLE_IDS[ROLES.BRANCH_MANAGER]}
        ORDER BY um.created_at ASC
        LIMIT 1
      ) u ON true
      WHERE b.tenant_id = $1
        AND ($2::text IS NULL OR b.status = $2)
        AND (
          $3::text IS NULL
          OR b.name ILIKE '%' || $3 || '%'
          OR b.id::text ILIKE '%' || $3 || '%'
          OR (
            $4::text IS NOT NULL
            AND REPLACE(LOWER(b.id::text), '-', '') ILIKE '%' || $4 || '%'
          )
          OR COALESCE(b.location, '') ILIKE '%' || $3 || '%'
          OR COALESCE(u.full_name, '') ILIKE '%' || $3 || '%'
          OR COALESCE(u.email, '') ILIKE '%' || $3 || '%'
        )
      ORDER BY b.name ASC, b.created_at ASC
      LIMIT $5 OFFSET $6
    `,
    [status, q, qHex, limit, offset],
  )

  return {
    items: rows.map(mapBranchRow),
    total: countRows[0]?.total || 0,
    page,
    limit,
  }
}

export async function getBranchById(tenantId, id) {
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT ${branchSelect}
      FROM branches b
      LEFT JOIN users u
        ON u.tenant_id = b.tenant_id
       AND u.branch_id = b.id
       AND u.role_id = ${ROLE_IDS[ROLES.BRANCH_MANAGER]}
      WHERE b.tenant_id = $1 AND b.id = $2
      ORDER BY u.created_at ASC NULLS LAST
      LIMIT 1
    `,
    [id],
  )
  return mapBranchRow(rows[0] || null)
}

// One transaction: branch + BM user. Caller supplies passwordHash + plaintext for email.
export async function createBranchWithManager(tenantId, payload) {
  try {
    return await withTransaction(async (client) => {
      // Omit workingDays → full week (matches migration default)
      const workingDays =
        Array.isArray(payload.workingDays) && payload.workingDays.length
          ? payload.workingDays
          : FULL_WEEK_DAYS

      const { rows: branchRows } = await tenantClientQuery(
        client,
        tenantId,
        `
          INSERT INTO branches (
            tenant_id, name, location, image_url, status,
            opening_time, closing_time, working_days
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id
        `,
        [
          payload.name.trim(),
          payload.location?.trim() || null,
          payload.image || payload.imageUrl || null,
          payload.status || BRANCH_STATUS.OPEN,
          payload.openingTime || null,
          payload.closingTime || null,
          workingDays,
        ],
      )

      const branchId = branchRows[0].id

      await tenantClientQuery(
        client,
        tenantId,
        `
          INSERT INTO users (
            tenant_id, branch_id, role_id, full_name, email, password_hash,
            phone, other_phone, gender, address, image_url, is_active, credentials_emailed
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, false)
        `,
        [
          branchId,
          ROLE_IDS[ROLES.BRANCH_MANAGER],
          payload.manager.name.trim(),
          payload.manager.email.trim().toLowerCase(),
          payload.passwordHash,
          payload.manager.contact?.trim() || null,
          payload.manager.otherContact?.trim() || null,
          payload.manager.gender?.trim() || null,
          payload.manager.address?.trim() || null,
          payload.manager.profileImage || payload.manager.imageUrl || null,
        ],
      )

      return getBranchByIdInTx(client, tenantId, branchId)
    })
  } catch (err) {
    mapPgUniqueViolation(err, 'A user with this email already exists for this company')
  }
}

export async function updateBranch(tenantId, id, payload) {
  try {
    return await withTransaction(async (client) => {
      const existing = await getBranchByIdInTx(client, tenantId, id)
      if (!existing) throw httpError(404, 'Branch not found')

      if (
        payload.name !== undefined ||
        payload.location !== undefined ||
        payload.image !== undefined ||
        payload.imageUrl !== undefined ||
        payload.openingTime !== undefined ||
        payload.closingTime !== undefined ||
        payload.workingDays !== undefined
      ) {
        await tenantClientQuery(
          client,
          tenantId,
          `
            UPDATE branches
            SET
              name = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE name END,
              location = CASE WHEN $4::boolean THEN $5 ELSE location END,
              image_url = CASE WHEN $6::boolean THEN $7 ELSE image_url END,
              opening_time = CASE WHEN $8::boolean THEN $9::time ELSE opening_time END,
              closing_time = CASE WHEN $10::boolean THEN $11::time ELSE closing_time END,
              working_days = CASE WHEN $12::boolean THEN $13::text[] ELSE working_days END
            WHERE tenant_id = $1 AND id = $2
          `,
          [
            id,
            payload.name !== undefined ? payload.name.trim() : null,
            payload.location !== undefined,
            payload.location !== undefined ? payload.location?.trim() || null : null,
            payload.image !== undefined || payload.imageUrl !== undefined,
            payload.image !== undefined || payload.imageUrl !== undefined
              ? payload.image || payload.imageUrl || null
              : null,
            payload.openingTime !== undefined,
            payload.openingTime !== undefined ? payload.openingTime || null : null,
            payload.closingTime !== undefined,
            payload.closingTime !== undefined ? payload.closingTime || null : null,
            payload.workingDays !== undefined,
            payload.workingDays !== undefined ? payload.workingDays : null,
          ],
        )
      }

      if (payload.manager && existing.manager?.id) {
        const m = payload.manager
        await tenantClientQuery(
          client,
          tenantId,
          `
            UPDATE users
            SET
              full_name = CASE WHEN $3::text IS NOT NULL THEN $3 ELSE full_name END,
              email = CASE WHEN $4::text IS NOT NULL THEN lower($4) ELSE email END,
              phone = CASE WHEN $5::boolean THEN $6 ELSE phone END,
              other_phone = CASE WHEN $7::boolean THEN $8 ELSE other_phone END,
              gender = CASE WHEN $9::boolean THEN $10 ELSE gender END,
              address = CASE WHEN $11::boolean THEN $12 ELSE address END,
              image_url = CASE WHEN $13::boolean THEN $14 ELSE image_url END
            WHERE tenant_id = $1
              AND id = $2
              AND role_id = ${ROLE_IDS[ROLES.BRANCH_MANAGER]}
          `,
          [
            existing.manager.id,
            m.name !== undefined ? m.name.trim() : null,
            m.email !== undefined ? m.email.trim() : null,
            m.contact !== undefined,
            m.contact !== undefined ? m.contact?.trim() || null : null,
            m.otherContact !== undefined,
            m.otherContact !== undefined ? m.otherContact?.trim() || null : null,
            m.gender !== undefined,
            m.gender !== undefined ? m.gender?.trim() || null : null,
            m.address !== undefined,
            m.address !== undefined ? m.address?.trim() || null : null,
            m.profileImage !== undefined || m.imageUrl !== undefined,
            m.profileImage !== undefined || m.imageUrl !== undefined
              ? m.profileImage || m.imageUrl || null
              : null,
          ],
        )
      } else if (payload.manager && !existing.manager?.id) {
        throw httpError(400, 'Branch has no manager to update')
      }

      return getBranchByIdInTx(client, tenantId, id)
    })
  } catch (err) {
    mapPgUniqueViolation(err, 'A user with this email already exists for this company')
  }
}

// Soft-block / reopen a branch. Never deletes rows — only flips access flags.
// Block: all branch users lose login (web + POS); active staff marked status='blocked'.
// Open: restore staff that were branch-blocked; re-enable BM + users linked to active staff.
// Manually inactive staff stay inactive on reopen.
export async function setBranchStatus(tenantId, id, status) {
  const row = await withTransaction(async (client) => {
    const existing = await getBranchByIdInTx(client, tenantId, id)
    if (!existing) throw httpError(404, 'Branch not found')

    await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE branches
        SET status = $3
        WHERE tenant_id = $1 AND id = $2
      `,
      [id, status],
    )

    if (status === BRANCH_STATUS.BLOCKED) {
      // Mark currently-active staff as branch-blocked (keep manual 'inactive' distinct).
      await tenantClientQuery(
        client,
        tenantId,
        `
          UPDATE staff
          SET status = 'inactive'
          WHERE tenant_id = $1
            AND branch_id = $2
            AND status = 'active'
        `,
        [id],
      )

      // Deactivate every login under this branch (BM, IM, cashier, other roles).
      await tenantClientQuery(
        client,
        tenantId,
        `
          UPDATE users
          SET is_active = false
          WHERE tenant_id = $1
            AND branch_id = $2
        `,
        [id],
      )
    } else {
      // Restore only staff that were soft-blocked by this branch action.
      await tenantClientQuery(
        client,
        tenantId,
        `
          UPDATE staff
          SET status = 'active'
          WHERE tenant_id = $1
            AND branch_id = $2
            AND status = 'inactive'
        `,
        [id],
      )

      // Re-enable BM always; re-enable other roles only when their staff row is active again.
      await tenantClientQuery(
        client,
        tenantId,
        `
          UPDATE users u
          SET is_active = true
          WHERE u.tenant_id = $1
            AND u.branch_id = $2
            AND (
              u.role_id = ${ROLE_IDS[ROLES.BRANCH_MANAGER]}
              OR EXISTS (
                SELECT 1
                FROM staff s
                WHERE s.tenant_id = u.tenant_id
                  AND s.user_id = u.id
                  AND s.status = 'active'
              )
            )
        `,
        [id],
      )
    }

    return getBranchByIdInTx(client, tenantId, id)
  })

  // Drop open web/desktop sessions so blocked users cannot keep calling APIs.
  if (status === BRANCH_STATUS.BLOCKED) {
    await revokeForBranch(tenantId, id)
  }

  return row
}

export async function resetBranchManagerPassword(tenantId, id, passwordHash) {
  return withTransaction(async (client) => {
    const existing = await getBranchByIdInTx(client, tenantId, id)
    if (!existing) throw httpError(404, 'Branch not found')
    if (!existing.manager?.id) throw httpError(404, 'Branch manager not found')

    await tenantClientQuery(
      client,
      tenantId,
      `
        UPDATE users
        SET
          password_hash = $3,
          credentials_emailed = false
        WHERE tenant_id = $1 AND id = $2
      `,
      [existing.manager.id, passwordHash],
    )

    return getBranchByIdInTx(client, tenantId, id)
  })
}

// Persist whether BM credentials email was delivered (controls admin Key icon).
export async function setManagerCredentialsEmailed(tenantId, managerUserId, emailed) {
  await tenantQuery(
    tenantId,
    `
      UPDATE users
      SET credentials_emailed = $3
      WHERE tenant_id = $1 AND id = $2
    `,
    [managerUserId, Boolean(emailed)],
  )
}

// Hard-delete branch + its users when safe.
// Blocks (409) if inventory masters / ledger still reference the branch (RESTRICT FKs).
export async function deleteBranch(tenantId, id) {
  return withTransaction(async (client) => {
    const existing = await getBranchByIdInTx(client, tenantId, id)
    if (!existing) throw httpError(404, 'Branch not found')

    const { rows: depRows } = await tenantClientQuery(
      client,
      tenantId,
      `
        SELECT
          (SELECT count(*)::int FROM products p
            WHERE p.tenant_id = $1 AND p.branch_id = $2) AS products,
          (SELECT count(*)::int FROM categories c
            WHERE c.tenant_id = $1 AND c.branch_id = $2) AS categories,
          (SELECT count(*)::int FROM suppliers s
            WHERE s.tenant_id = $1 AND s.branch_id = $2) AS suppliers,
          (SELECT count(*)::int FROM purchase_orders po
            WHERE po.tenant_id = $1 AND po.branch_id = $2) AS "purchaseOrders",
          (SELECT count(*)::int FROM inventory_ledger il
            WHERE il.tenant_id = $1
              AND (il.from_branch_id = $2 OR il.to_branch_id = $2)
          ) AS ledger,
          (SELECT count(*)::int FROM pos_sync_events pse
            WHERE pse.tenant_id = $1 AND pse.branch_id = $2) AS "posSync"
      `,
      [id],
    )

    const deps = depRows[0] || {}
    const blockers = []
    if (deps.products > 0) blockers.push(`${deps.products} product(s)`)
    if (deps.categories > 0) blockers.push(`${deps.categories} categor(ies)`)
    if (deps.suppliers > 0) blockers.push(`${deps.suppliers} supplier(s)`)
    if (deps.purchaseOrders > 0) blockers.push(`${deps.purchaseOrders} purchase order(s)`)
    if (deps.ledger > 0) blockers.push(`${deps.ledger} ledger movement(s)`)
    if (deps.posSync > 0) blockers.push(`${deps.posSync} POS sync event(s)`)

    if (blockers.length) {
      throw httpError(
        409,
        `Cannot delete branch — linked data still exists (${blockers.join(', ')}). Block the branch instead, or remove that data first.`,
      )
    }

    // Remove branch-scoped users (BM / IM / cashier); staff rows cascade from users.
    await tenantClientQuery(
      client,
      tenantId,
      `
        DELETE FROM users
        WHERE tenant_id = $1 AND branch_id = $2
      `,
      [id],
    )

    const { rows: deleted } = await tenantClientQuery(
      client,
      tenantId,
      `
        DELETE FROM branches
        WHERE tenant_id = $1 AND id = $2
        RETURNING id, name
      `,
      [id],
    )

    if (!deleted[0]) throw httpError(404, 'Branch not found')
    return { id: deleted[0].id, name: deleted[0].name, deleted: true }
  })
}

export async function getTenantName(tenantId) {
  const { rows } = await tenantQuery(
    tenantId,
    `SELECT name FROM tenants WHERE id = $1 LIMIT 1`,
    [],
  )
  return rows[0]?.name || null
}

// Branch hours + calendar for staff shift / working-day bounds.
export async function getBranchHours(tenantId, branchId) {
  if (!branchId) {
    return { openingTime: null, closingTime: null, workingDays: [] }
  }
  const { rows } = await tenantQuery(
    tenantId,
    `
      SELECT
        to_char(opening_time, 'HH24:MI') AS "openingTime",
        to_char(closing_time, 'HH24:MI') AS "closingTime",
        COALESCE(working_days, ARRAY[]::text[]) AS "workingDays"
      FROM branches
      WHERE tenant_id = $1 AND id = $2
      LIMIT 1
    `,
    [branchId],
  )
  const row = rows[0]
  if (!row) return null
  return {
    openingTime: formatTimeValue(row.openingTime),
    closingTime: formatTimeValue(row.closingTime),
    workingDays: Array.isArray(row.workingDays) ? row.workingDays : [],
  }
}
