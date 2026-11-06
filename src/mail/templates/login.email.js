export function buildLoginCredentialsEmail({
  recipientName,
  loginEmail,
  temporaryPassword,
  branchName,
  companyName,
  loginUrl,
  roleLabel = 'Branch Manager',
}) {
  const safeName = recipientName || 'there'
  const subject = `Your ${roleLabel} login — ${companyName || 'FluxOne'}`

  const text = [
    `Hi ${safeName},`,
    '',
    `Your ${roleLabel} account for ${branchName || 'your branch'} is ready.`,
    '',
    `Login email: ${loginEmail}`,
    `Temporary password: ${temporaryPassword}`,
    loginUrl ? `Sign in: ${loginUrl}` : null,
    '',
    'For security, sign in and change this temporary password from your Profile page (Edit → Password).',
    '',
    'If you did not expect this email, contact your company admin.',
    '',
    `— ${companyName || 'FluxOne Inventory'}`,
  ]
    .filter(Boolean)
    .join('\n')

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>${subject}</title></head>
<body style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#0f172a;background:#f8fafc;padding:24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e2e8f0;">
    <tr><td>
      <p style="margin:0 0 12px;font-size:14px;color:#64748b;">FluxOne Inventory</p>
      <h1 style="margin:0 0 16px;font-size:20px;color:#0f172a;">Welcome, ${escapeHtml(safeName)}</h1>
      <p style="margin:0 0 16px;">Your <strong>${escapeHtml(roleLabel)}</strong> account for <strong>${escapeHtml(branchName || 'your branch')}</strong>${companyName ? ` at <strong>${escapeHtml(companyName)}</strong>` : ''} is ready.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:8px;padding:16px;margin:0 0 20px;">
        <tr><td style="padding:4px 0;font-size:14px;"><strong>Login email</strong><br/>${escapeHtml(loginEmail)}</td></tr>
        <tr><td style="padding:4px 0;font-size:14px;"><strong>Temporary password</strong><br/><code style="font-size:15px;">${escapeHtml(temporaryPassword)}</code></td></tr>
      </table>
      ${
        loginUrl
          ? `<p style="margin:0 0 16px;"><a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;">Sign in</a></p>`
          : ''
      }
      <p style="margin:0 0 8px;font-size:14px;color:#334155;"><strong>Important:</strong> This is a first-time password. After you sign in, open Profile → Edit and set a new password (Password + Confirm Password).</p>
      <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">If you did not expect this email, contact your company admin.</p>
    </td></tr>
  </table>
</body>
</html>`

  return { subject, text, html }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
