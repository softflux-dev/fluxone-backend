// Shared email shell — same brand palette as the web app (src/lib/constants.js BRAND).
// Table + inline CSS only: Gmail/Outlook strip <style> and ignore flex/grid.
export const MAIL_BRAND = {
  product: 'FluxOne',
  tagline: 'Management System',
  purple: '#8E238F',
  deep: '#412283',
  soft: '#f3e8f5',
  ink: '#0f172a',
  muted: '#64748b',
  line: '#e2e8f0',
  page: '#f6f1f8',
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function emailButton(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;"><tr>
    <td align="center" bgcolor="${MAIL_BRAND.purple}" style="border-radius:10px;">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 28px;font-family:Segoe UI,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
    </td></tr></table>`
}

/**
 * @param {{ title: string, preheader?: string, bodyHtml: string, footerNote?: string, companyName?: string }} opts
 */
export function emailShell({ title, preheader = '', bodyHtml, footerNote = '', companyName = '' }) {
  const b = MAIL_BRAND
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${b.page};font-family:Segoe UI,Arial,sans-serif;color:${b.ink};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${b.page};padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid ${b.line};">
        <tr>
          <td bgcolor="${b.deep}" style="background:${b.deep};background-image:linear-gradient(135deg,${b.deep},${b.purple});padding:26px 32px;">
            <div style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:.3px;">${b.product}</div>
            <div style="font-size:12px;color:#e9d5ee;letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;">${b.tagline}</div>
          </td>
        </tr>
        <tr><td style="padding:32px 32px 8px;font-size:15px;line-height:1.6;color:${b.ink};">
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:8px 32px 28px;">
          ${footerNote ? `<p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:${b.muted};">${footerNote}</p>` : ''}
        </td></tr>
        <tr><td bgcolor="${b.soft}" style="background:${b.soft};padding:16px 32px;font-size:12px;color:${b.muted};text-align:center;">
          ${companyName ? `${escapeHtml(companyName)} · ` : ''}Powered by ${b.product} ${b.tagline}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}
