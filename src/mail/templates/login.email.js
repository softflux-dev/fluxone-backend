import { MAIL_BRAND, emailButton, emailShell, escapeHtml } from './layout.js'

// Credentials email — shared by Branch Manager / Inventory Manager (generated
// temporary password) and Cashier (password chosen by the BM, ID-based login).
//
// mode:
//   'generated' — server-generated temporary password (BM, IM)
//   'assigned'  — password set by the Branch Manager at creation (Cashier)
//   'reset'     — Branch Manager changed the password (Cashier)
export function buildLoginCredentialsEmail({
  recipientName,
  loginEmail,
  temporaryPassword,
  branchName,
  companyName,
  loginUrl,
  roleLabel = 'Branch Manager',
  mode = 'generated',
  loginLabel = 'Login email',
}) {
  const b = MAIL_BRAND
  const safeName = recipientName || 'there'
  const where = branchName || 'your branch'
  const isReset = mode === 'reset'
  const isGenerated = mode === 'generated'
  const passwordLabel = isGenerated ? 'Temporary password' : 'Password'

  const subject = isReset
    ? `Your ${roleLabel} password was updated — ${companyName || 'FluxOne'}`
    : `Your ${roleLabel} login — ${companyName || 'FluxOne'}`

  const intro = isReset
    ? `Your Branch Manager updated the password for your ${roleLabel} account at ${where}.`
    : isGenerated
      ? `Your ${roleLabel} account for ${where} is ready.`
      : `Your ${roleLabel} account for ${where} is ready. Your Branch Manager has set your password.`

  const notice = isGenerated
    ? 'After signing in, open Profile → Edit and set a new password.'
    : 'Keep this password safe. If you forget it, ask your Branch Manager to reset it — there is no self-service password reset for this account.'
  const noticeTitle = isGenerated ? 'First-time password.' : 'Need a new password?'

  const text = [
    `Hi ${safeName},`,
    '',
    intro,
    '',
    `${loginLabel}: ${loginEmail}`,
    `${passwordLabel}: ${temporaryPassword}`,
    loginUrl ? `Sign in: ${loginUrl}` : null,
    '',
    `${noticeTitle} ${notice}`,
    '',
    'If you did not expect this email, contact your Branch Manager or company admin.',
    '',
    `— ${companyName || 'FluxOne Management System'}`,
  ]
    .filter((line) => line !== null)
    .join('\n')

  const label = (t) =>
    `<div style="font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:${b.muted};">${escapeHtml(t)}</div>`

  const bodyHtml = `
    <h1 style="margin:0 0 6px;font-size:22px;color:${b.deep};">${isReset ? 'Your password was updated' : `Welcome, ${escapeHtml(safeName)}`}</h1>
    <p style="margin:0 0 20px;color:#334155;">${isReset ? `Hi ${escapeHtml(safeName)}, your` : 'Your'} <strong>${escapeHtml(roleLabel)}</strong> account ${isReset ? 'at' : 'for'} <strong>${escapeHtml(where)}</strong>${companyName ? ` at <strong>${escapeHtml(companyName)}</strong>` : ''} ${isReset ? 'has a new password set by your Branch Manager.' : isGenerated ? 'is ready. Use the details below to sign in.' : 'is ready. Your Branch Manager has set your password — use the details below to sign in.'}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${b.soft};border-left:4px solid ${b.purple};border-radius:10px;margin:0 0 22px;">
      <tr><td style="padding:14px 18px 6px;">
        ${label(loginLabel)}
        <div style="margin-top:3px;font-size:15px;font-weight:600;color:${b.deep};">${escapeHtml(loginEmail)}</div>
      </td></tr>
      <tr><td style="padding:10px 18px 16px;">
        ${label(passwordLabel)}
        <div style="margin-top:3px;font-size:18px;font-weight:700;color:${b.deep};font-family:Consolas,Menlo,monospace;letter-spacing:1px;">${escapeHtml(temporaryPassword)}</div>
      </td></tr>
    </table>
    ${loginUrl ? emailButton(loginUrl, 'Sign in to FluxOne') : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;">
      <tr><td style="padding:12px 16px;font-size:13px;line-height:1.5;color:#92400e;">
        <strong>${escapeHtml(noticeTitle)}</strong> ${escapeHtml(notice)}
      </td></tr>
    </table>`

  const html = emailShell({
    title: subject,
    preheader: isReset
      ? `Your ${roleLabel} password was updated.`
      : `Your ${roleLabel} login for ${where} is ready.`,
    bodyHtml,
    footerNote:
      'If you did not expect this email, contact your Branch Manager or company admin. Never share your password with anyone.',
    companyName,
  })

  return { subject, text, html }
}
