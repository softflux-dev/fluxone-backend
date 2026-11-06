// TL §10.3 — email purchase order invoice PDF to supplier representative
export function buildPurchaseOrderInvoiceEmail({
  supplierName,
  representativeName,
  invoiceNumber,
  orderNumber,
  branchName,
  companyName,
}) {
  const safeRep = representativeName || 'there'
  const inv = invoiceNumber || '—'
  const orderRef = orderNumber || '—'
  const subject = `Purchase order invoice ${inv} — ${branchName || companyName || 'FluxOne'}`

  const text = [
    `Hi ${safeRep},`,
    '',
    `Please find attached purchase order invoice ${inv} for order ${orderRef}.`,
    supplierName ? `Supplier: ${supplierName}` : null,
    branchName ? `Issuing branch: ${branchName}` : null,
    '',
    'This invoice reflects the approved quantities for your company on this order.',
    '',
    `— ${companyName || 'FluxOne Inventory'}`,
  ]
    .filter(Boolean)
    .join('\n')

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#0f172a;background:#f8fafc;padding:24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e2e8f0;">
    <tr><td>
      <p style="margin:0 0 12px;font-size:14px;color:#64748b;">FluxOne Inventory</p>
      <h1 style="margin:0 0 8px;font-size:20px;color:#0f172a;">Purchase order invoice</h1>
      <p style="margin:0 0 16px;">Hi ${escapeHtml(safeRep)}, please find your invoice attached.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:8px;padding:16px;margin:0 0 20px;">
        <tr><td style="padding:4px 0;font-size:14px;"><strong>Invoice #</strong><br/>${escapeHtml(inv)}</td></tr>
        <tr><td style="padding:4px 0;font-size:14px;"><strong>Order #</strong><br/>${escapeHtml(orderRef)}</td></tr>
        ${supplierName ? `<tr><td style="padding:4px 0;font-size:14px;"><strong>Supplier</strong><br/>${escapeHtml(supplierName)}</td></tr>` : ''}
        ${branchName ? `<tr><td style="padding:4px 0;font-size:14px;"><strong>Branch</strong><br/>${escapeHtml(branchName)}</td></tr>` : ''}
      </table>
      <p style="margin:0;font-size:12px;color:#94a3b8;">Quantities match the Branch Manager–approved order request.</p>
    </td></tr>
  </table>
</body>
</html>`

  return { subject, text, html }
}

// Confirm to BM that supplier invoice email was sent
export function buildPurchaseOrderInvoiceSentBmEmail({
  recipientName,
  invoiceNumber,
  orderNumber,
  supplierName,
  sentTo,
  stubbed = false,
}) {
  const safeName = recipientName || 'there'
  const inv = invoiceNumber || '—'
  const subject = stubbed
    ? `Invoice email stubbed — ${inv}`
    : `Invoice emailed to supplier — ${inv}`

  const text = [
    `Hi ${safeName},`,
    '',
    stubbed
      ? `SMTP is not configured. Invoice ${inv} for order ${orderNumber || '—'} was prepared for ${sentTo || 'the supplier'} but not sent.`
      : `Invoice ${inv} for order ${orderNumber || '—'} was emailed to ${sentTo || 'the supplier'}.`,
    supplierName ? `Supplier: ${supplierName}` : null,
    '',
    '— FluxOne Inventory',
  ]
    .filter(Boolean)
    .join('\n')

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><title>${escapeHtml(subject)}</title></head>
<body style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#0f172a;background:#f8fafc;padding:24px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px;border:1px solid #e2e8f0;">
    <tr><td>
      <p style="margin:0 0 12px;font-size:14px;color:#64748b;">FluxOne Inventory</p>
      <h1 style="margin:0 0 8px;font-size:20px;color:#0f172a;">Supplier invoice email</h1>
      <p style="margin:0 0 16px;">Hi ${escapeHtml(safeName)},</p>
      <p style="margin:0 0 16px;">${
        stubbed
          ? `SMTP is not configured. Invoice <strong>${escapeHtml(inv)}</strong> was prepared but not delivered.`
          : `Invoice <strong>${escapeHtml(inv)}</strong> was emailed to the supplier.`
      }</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;border-radius:8px;padding:16px;">
        <tr><td style="padding:4px 0;font-size:14px;"><strong>Order #</strong><br/>${escapeHtml(orderNumber || '—')}</td></tr>
        <tr><td style="padding:4px 0;font-size:14px;"><strong>Sent to</strong><br/>${escapeHtml(sentTo || '—')}</td></tr>
        ${supplierName ? `<tr><td style="padding:4px 0;font-size:14px;"><strong>Supplier</strong><br/>${escapeHtml(supplierName)}</td></tr>` : ''}
      </table>
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
