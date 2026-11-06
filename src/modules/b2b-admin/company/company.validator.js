import { z } from 'zod'
import { empty } from '../../branch-manager/shared.validator.js'

const optionalString = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.string().optional(),
)

function isValidPhone(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/[\s()-]/g, '')
  if (!cleaned) return false
  if (/[a-zA-Z]/.test(cleaned)) return false
  if (cleaned.startsWith('+92')) return cleaned.slice(3).length === 10
  if (cleaned.startsWith('03')) return cleaned.length === 11
  if (cleaned.startsWith('+')) return cleaned.length >= 9 && cleaned.length <= 16
  const digits = cleaned.replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 15
}

const optionalPhone = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z
    .string()
    .trim()
    .max(64)
    .refine(isValidPhone, { message: 'Invalid phone number' })
    .optional(),
)

// Primary contact — same E.164 rules as WhatsApp (PhoneInput)
const optionalContactNumbers = optionalPhone

const optionalEmail = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z.string().trim().email().max(190).optional(),
)

const optionalUrl = z.preprocess(
  (value) => (value === '' || value === null || value === undefined ? undefined : value),
  z
    .string()
    .trim()
    .max(500)
    .refine(
      (url) =>
        /^(https?:\/\/)?(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)$/i.test(
          url,
        ),
      { message: 'Invalid URL' },
    )
    .optional(),
)

export const getCompanySchema = z.object({
  body: empty,
  query: empty,
  params: empty,
})

export const updateCompanySchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(200).optional(),
    contactNumbers: optionalContactNumbers,
    whatsappNumber: optionalPhone,
    facebookUrl: optionalUrl,
    instagramUrl: optionalUrl,
    registrationTaxId: optionalString,
    businessAddress: optionalString,
    supportEmail: optionalEmail,
    logoUrl: optionalString,
  }),
  query: empty,
  params: empty,
})
