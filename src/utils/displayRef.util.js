// Display refs (LV-XXXXXXXX / BRN-XXXXXXXX) are UI-only — derived from UUID, not stored.

// Strip paste artifacts so prefixed IDs match reliably.
export function normalizeSearchQuery(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

export function referenceFromUuid(id, prefix = 'REF') {
  if (!id) return ''
  const compact = String(id).replace(/-/g, '').slice(0, 8).toUpperCase()
  return `${prefix}-${compact}`
}

// True when query matches raw UUID, compact hex, or PREFIX-XXXXXXXX display ref.
export function matchesDisplayRef(entityId, query, prefix) {
  const q = normalizeSearchQuery(query).toLowerCase()
  if (!q || !entityId) return false

  const id = String(entityId).toLowerCase()
  const compact = id.replace(/-/g, '')
  const display = referenceFromUuid(entityId, prefix).toLowerCase()
  const prefixRe = new RegExp(`^${String(prefix).toLowerCase()}[-_\\s]?`)
  const qHex = q.replace(prefixRe, '').replace(/-/g, '')

  if (id.includes(q) || display.includes(q) || compact.includes(q.replace(/-/g, ''))) {
    return true
  }
  return qHex.length >= 4 && compact.includes(qHex)
}

// Hex fragment extracted from a display-style query (for SQL ILIKE on compact UUID).
export function displayRefSearchHex(query, prefix) {
  const q = normalizeSearchQuery(query).toLowerCase()
  if (!q) return null
  const prefixRe = new RegExp(`^${String(prefix).toLowerCase()}[-_\\s]?`)
  const hex = q.replace(prefixRe, '').replace(/-/g, '')
  return hex.length >= 4 ? hex : null
}
