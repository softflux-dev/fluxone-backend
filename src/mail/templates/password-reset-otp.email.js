export function buildPasswordResetOtpEmail({ otp, expiresInMinutes }) {
  const subject = 'Your FluxOne password reset code'

  const text = [
    `Your FluxOne password reset code is: ${otp}`,
    `It is valid for ${expiresInMinutes} minutes. Do not share it with anyone.`,
    'If you did not request this, you can ignore this email.',
  ].join('\n\n')

  const html = `
    <p>Your FluxOne password reset code is:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:12px 0">${otp}</p>
    <p>This code is valid for ${expiresInMinutes} minutes. Do not share it with anyone.</p>
    <p>If you did not request this, you can ignore this email.</p>
  `

  return { subject, text, html }
}