// Public sign-in URL used in credential emails.
export function loginAppUrl() {
  const base = (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',')[0].trim()
  return `${base.replace(/\/$/, '')}/login`
}
