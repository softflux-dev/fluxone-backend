import nodemailer from 'nodemailer'
import { buildLoginCredentialsEmail } from './templates/login.email.js'
import { buildPasswordResetOtpEmail } from './templates/password-reset-otp.email.js'
import {
  buildPurchaseOrderInvoiceEmail,
  buildPurchaseOrderInvoiceSentBmEmail,
} from './templates/purchase-order-invoice.email.js'

let transporter = null

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}

function getTransporter() {
  if (!smtpConfigured()) return null
  if (transporter) return transporter

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Fail fast — never hang create/submit HTTP on SMTP (QA form unresponsive)
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  })
  return transporter
}

async function sendMail({ to, subject, text, html, attachments = [] }) {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@fluxone.local'

  if (!smtpConfigured()) {
    console.info('[mail] SMTP not configured — stubbing email', {
      to,
      subject,
      attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
    })
    return { sent: false, stubbed: true }
  }

  try {
    const tx = getTransporter()
    await tx.sendMail({
      from,
      to,
      subject,
      text,
      html,
      attachments: Array.isArray(attachments) ? attachments : [],
    })
    console.info('[mail] Email sent', { to, subject })
    return { sent: true, stubbed: false }
  } catch (err) {
    console.error('[mail] Failed to send email (non-blocking):', err?.message || err)
    return { sent: false, stubbed: false, error: err?.message || 'send failed' }
  }
}

// Send login credentials. Never throws for transport failures — create/reset must not block.
export async function sendLoginCredentialsEmail(payload) {
  const { subject, text, html } = buildLoginCredentialsEmail(payload)
  const result = await sendMail({ to: payload.loginEmail, subject, text, html })
  if (!result.sent && result.stubbed) {
    console.info('[mail] Stub credentials payload', {
      loginEmail: payload.loginEmail,
      temporaryPassword: payload.temporaryPassword,
      branchName: payload.branchName,
    })
  }
  if (!result.sent && !result.stubbed) {
    console.info('[mail] Fallback log for manual delivery', {
      to: payload.loginEmail,
      loginEmail: payload.loginEmail,
      temporaryPassword: payload.temporaryPassword,
    })
  }
  return result
}

// TL §10.3 — send invoice PDF to supplier representative (non-blocking / SMTP stub)
export async function sendPurchaseOrderInvoiceEmail(payload) {
  const { subject, text, html } = buildPurchaseOrderInvoiceEmail(payload)
  const filename = payload.filename || `${payload.invoiceNumber || 'invoice'}.pdf`
  const attachments = payload.pdfBuffer
    ? [
        {
          filename,
          content: payload.pdfBuffer,
          contentType: 'application/pdf',
        },
      ]
    : []

  const result = await sendMail({
    to: payload.toEmail,
    subject,
    text,
    html,
    attachments,
  })
  if (!result.sent && result.stubbed) {
    console.info('[mail] Stub PO invoice email', {
      to: payload.toEmail,
      invoiceNumber: payload.invoiceNumber,
      orderNumber: payload.orderNumber,
      filename,
    })
  }
  return result
}

// Confirm to BM that supplier invoice email was attempted / sent
export async function sendPurchaseOrderInvoiceSentBmEmail(payload) {
  const { subject, text, html } = buildPurchaseOrderInvoiceSentBmEmail(payload)
  return sendMail({ to: payload.toEmail, subject, text, html })
}

// Password reset OTP (non-blocking; SMTP na ho to stub)
export async function sendPasswordResetOtpEmail(payload) {
  const { subject, text, html } = buildPasswordResetOtpEmail(payload)
  return sendMail({ to: payload.toEmail, subject, text, html })
}
