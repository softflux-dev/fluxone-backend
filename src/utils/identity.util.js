function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

// Login IDs / mailboxes are one identity space across the whole system: login is
// case-insensitive and not tenant-scoped, so a clash would log into (or mail) another account.
// `run` = (sql, params) => Promise<{ rows }> — pass client.query in a tx, or pool query.
export async function assertIdentityAvailable(run, { loginId, contactEmail, excludeUserId = null }) {
  const login = String(loginId || '').trim().toLowerCase()
  const contact = String(contactEmail || '').trim().toLowerCase()
  const wanted = [login, contact].filter(Boolean)
  if (!wanted.length) return
  const { rows } = await run(
    `
      SELECT lower(email) AS email, lower(contact_email) AS contact
      FROM users
      WHERE ($2::uuid IS NULL OR id <> $2)
        AND (lower(email) = ANY($1::text[]) OR lower(contact_email) = ANY($1::text[]))
    `,
    [wanted, excludeUserId],
  )
  if (!rows.length) return
  if (login && rows.some((r) => r.email === login || r.contact === login)) {
    throw httpError(409, 'A user with this Login ID/Email already exists')
  }
  throw httpError(409, 'This email is already registered to another account')
}
