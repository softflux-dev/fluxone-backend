import { MAIL_BRAND, emailButton, emailShell, escapeHtml } from './layout.js'

// Credentials email — shared by Branch Manager (Admin creates branch) and
// Inventory Manager (BM creates staff). Only roleLabel / branchName differ.
export function buildLoginCredentialsEmail({
  recipientName,
  loginEmail,
  temporaryPassword,
  branchName,
  companyName,
  loginUrl,
  roleLabel = 'Branch Manager',
}) {
  const b = MAIL_BRAND
  const safeName = recipientName || 'there'
  const where = branchName || 'your branch'
  const subject = `Your ${roleLabel} login — ${companyName || 'FluxOne'}`

  const text = [
    `Hi ${safeName},`,
    '',
    `Your ${roleLabel} account for ${where} is ready.`,
    '',
    `Login email: ${loginEmail}`,
    `Temporary password: ${temporaryPassword}`,
    loginUrl ? `Sign in: ${loginUrl}` : null,
    '',
    'For security, sign in and change this temporary password from your Profile page (Edit → Password).',
    '',
    'If you did not expect this email, contact your company admin.',
    '',
    `— ${companyName || 'FluxOne Management System'}`,
  ]
    .filter(Boolean)
    .join('\n')

  const label = (t) =>
    `<div style="font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:${b.muted};">${t}</div>`

  const bodyHtml = `
    <h1 style="margin:0 0 6px;font-size:22px;color:${b.deep};">Welcome, ${escapeHtml(safeName)}</h1>
    <p style="margin:0 0 20px;color:#334155;">Your <strong>${escapeHtml(roleLabel)}</strong> account for <strong>${escapeHtml(where)}</strong>${companyName ? ` at <strong>${escapeHtml(companyName)}</strong>` : ''} is ready. Use the details below to sign in.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${b.soft};border-left:4px solid ${b.purple};border-radius:10px;margin:0 0 22px;">
      <tr><td style="padding:14px 18px 6px;">
        ${label('Login email')}
        <div style="margin-top:3px;font-size:15px;font-weight:600;color:${b.deep};">${escapeHtml(loginEmail)}</div>
      </td></tr>
      <tr><td style="padding:10px 18px 16px;">
        ${label('Temporary password')}
        <div style="margin-top:3px;font-size:18px;font-weight:700;color:${b.deep};font-family:Consolas,Menlo,monospace;letter-spacing:1px;">${escapeHtml(temporaryPassword)}</div>
      </td></tr>
    </table>
    ${loginUrl ? emailButton(loginUrl, 'Sign in to FluxOne') : ''}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;">
      <tr><td style="padding:12px 16px;font-size:13px;line-height:1.5;color:#92400e;">
        <strong>First-time password.</strong> After signing in, open <strong>Profile → Edit</strong> and set a new password.
      </td></tr>
    </table>`

  const html = emailShell({
    title: subject,
    preheader: `Your ${roleLabel} login for ${where} is ready.`,
    bodyHtml,
    footerNote:
      'If you did not expect this email, contact your company admin. Never share your password with anyone.',
    companyName,
  })

  return { subject, text, html }
}
