function isSmsConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM_NUMBER,
  )
}

function normalizePhone(phone) {
  const raw = String(phone || '').trim()
  if (!raw) return null
  if (raw.startsWith('+')) return `+${raw.slice(1).replace(/\D/g, '')}`
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  return `+${digits}`
}

export async function sendSms({ to, body }) {
  const recipient = normalizePhone(to)
  if (!recipient) {
    const error = new Error('Recipient phone number is required')
    error.status = 422
    throw error
  }

  if (!body?.trim()) {
    const error = new Error('SMS body is required')
    error.status = 422
    throw error
  }

  if (!isSmsConfigured()) {
    console.info('[sms:log]', { to: recipient, body })
    return { sent: false, mode: 'log', to: recipient, body }
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const authToken = process.env.TWILIO_AUTH_TOKEN
  const from = process.env.TWILIO_FROM_NUMBER
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64')

  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      To: recipient,
      From: from,
      Body: body,
    }),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.message || 'Failed to send SMS')
    error.status = 502
    throw error
  }

  return {
    sent: true,
    mode: 'twilio',
    to: recipient,
    sid: payload.sid,
  }
}

export function buildPurchaseOrderSms(order) {
  const lines = order.lines
    .slice(0, 5)
    .map((line) => `${line.name} x${line.quantity} (${line.scale})`)
    .join('; ')
  const suffix = order.lines.length > 5 ? `; +${order.lines.length - 5} more item(s)` : ''

  return [
    `Purchase Order ${order.orderNumber}`,
    `From: ${order.companyName}`,
    `Items: ${lines}${suffix}`,
    order.explanation ? `Note: ${order.explanation}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}
