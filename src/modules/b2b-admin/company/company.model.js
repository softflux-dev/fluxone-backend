import { query } from '../../../config/db.js'
import { normalizeImageUrl } from '../../../utils/uploadUrl.util.js'

function mapCompanyRow(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name || '',
    slug: row.slug || '',
    logoUrl: normalizeImageUrl(row.logoUrl) || row.logoUrl || '',
    contactNumbers: row.contactNumbers || '',
    whatsappNumber: row.whatsappNumber || '',
    facebookUrl: row.facebookUrl || '',
    instagramUrl: row.instagramUrl || '',
    registrationTaxId: row.registrationTaxId || '',
    businessAddress: row.businessAddress || '',
    supportEmail: row.supportEmail || '',
    createdAt: row.createdAt,
  }
}

export async function getCompany(tenantId) {
  const { rows } = await query(
    `
      SELECT
        id,
        name,
        slug,
        logo_url AS "logoUrl",
        contact_numbers AS "contactNumbers",
        whatsapp_number AS "whatsappNumber",
        facebook_url AS "facebookUrl",
        instagram_url AS "instagramUrl",
        registration_tax_id AS "registrationTaxId",
        business_address AS "businessAddress",
        support_email AS "supportEmail",
        created_at AS "createdAt"
      FROM tenants
      WHERE id = $1
      LIMIT 1
    `,
    [tenantId],
  )
  return mapCompanyRow(rows[0] || null)
}

export async function updateCompany(tenantId, payload) {
  const existing = await getCompany(tenantId)
  if (!existing) {
    const error = new Error('Company not found')
    error.status = 404
    throw error
  }

  const { rows } = await query(
    `
      UPDATE tenants
      SET
        name = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE name END,
        contact_numbers = CASE WHEN $3::boolean THEN $4 ELSE contact_numbers END,
        whatsapp_number = CASE WHEN $5::boolean THEN $6 ELSE whatsapp_number END,
        facebook_url = CASE WHEN $7::boolean THEN $8 ELSE facebook_url END,
        instagram_url = CASE WHEN $9::boolean THEN $10 ELSE instagram_url END,
        registration_tax_id = CASE WHEN $11::boolean THEN $12 ELSE registration_tax_id END,
        business_address = CASE WHEN $13::boolean THEN $14 ELSE business_address END,
        support_email = CASE WHEN $15::boolean THEN $16 ELSE support_email END,
        logo_url = CASE WHEN $17::boolean THEN $18 ELSE logo_url END
      WHERE id = $1
      RETURNING
        id,
        name,
        slug,
        logo_url AS "logoUrl",
        contact_numbers AS "contactNumbers",
        whatsapp_number AS "whatsappNumber",
        facebook_url AS "facebookUrl",
        instagram_url AS "instagramUrl",
        registration_tax_id AS "registrationTaxId",
        business_address AS "businessAddress",
        support_email AS "supportEmail",
        created_at AS "createdAt"
    `,
    [
      tenantId,
      payload.name !== undefined ? payload.name.trim() : null,
      payload.contactNumbers !== undefined,
      payload.contactNumbers !== undefined ? payload.contactNumbers?.trim() || null : null,
      payload.whatsappNumber !== undefined,
      payload.whatsappNumber !== undefined ? payload.whatsappNumber?.trim() || null : null,
      payload.facebookUrl !== undefined,
      payload.facebookUrl !== undefined ? payload.facebookUrl?.trim() || null : null,
      payload.instagramUrl !== undefined,
      payload.instagramUrl !== undefined ? payload.instagramUrl?.trim() || null : null,
      payload.registrationTaxId !== undefined,
      payload.registrationTaxId !== undefined
        ? payload.registrationTaxId?.trim() || null
        : null,
      payload.businessAddress !== undefined,
      payload.businessAddress !== undefined ? payload.businessAddress?.trim() || null : null,
      payload.supportEmail !== undefined,
      payload.supportEmail !== undefined ? payload.supportEmail?.trim() || null : null,
      payload.logoUrl !== undefined,
      payload.logoUrl !== undefined ? payload.logoUrl || null : null,
    ],
  )

  return mapCompanyRow(rows[0] || null)
}
