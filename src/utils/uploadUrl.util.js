import path from 'path'
import { isCloudinaryConfigured } from '../config/cloudinary.js'

const CLOUDINARY_FOLDER = 'fluxone'

// Cloudinary / remote URL as stored in DB.
export function isAbsoluteImageUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

// Build a Cloudinary delivery URL from a public_id (e.g. fluxone/abc123).
export function cloudinaryDeliveryUrl(publicId) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME
  if (!cloudName || !publicId) return null

  let id = String(publicId).trim().replace(/\\/g, '/').replace(/^\/+/, '')

  // Strip mistaken local prefixes saved by older upload helpers
  id = id.replace(/^uploads\//, '')
  if (!id.startsWith(`${CLOUDINARY_FOLDER}/`)) {
    id = `${CLOUDINARY_FOLDER}/${id.replace(/^fluxone\//, '')}`
  }

  return `https://res.cloudinary.com/${cloudName}/image/upload/${id}`
}

// Normalize stored image paths for clients (IM web, POS offline sync).
// - HTTPS Cloudinary URLs pass through
// - Legacy fluxone public_ids → Cloudinary HTTPS URL
// - Local /uploads/<file> paths for disk storage
export function normalizeImageUrl(value) {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isAbsoluteImageUrl(trimmed)) return trimmed

  const normalized = trimmed.replace(/\\/g, '/')

  // Legacy broken paths saved as /uploads/fluxone/xxx — rebuild Cloudinary CDN URL
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME
  if (cloudName) {
    const legacyMatch = normalized.match(/^(?:\/uploads\/)?(fluxone\/[^/]+)$/)
    if (legacyMatch) {
      return cloudinaryDeliveryUrl(legacyMatch[1])
    }
    if (normalized.startsWith('fluxone/')) {
      return cloudinaryDeliveryUrl(normalized)
    }
  }

  if (normalized.startsWith('/uploads/')) return normalized

  // Absolute local filesystem path from old multer disk storage
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/')) {
    const base = path.basename(normalized)
    return base ? `/uploads/${base}` : null
  }

  const base = path.basename(normalized)
  return base ? `/uploads/${base}` : null
}

// Resolve a multer file to a storable public URL.
// Cloudinary → full https://res.cloudinary.com/... URL
// Local disk → /uploads/<filename>
export function resolveUploadUrl(file, req) {
  if (!file) return null

  if (file.secure_url) return file.secure_url
  if (file.url && isAbsoluteImageUrl(file.url)) return file.url

  const rawId = [file.public_id, file.filename, file.path].find(
    (v) => v && typeof v === 'string',
  )

  if (isCloudinaryConfigured() && rawId) {
    const id = String(rawId).replace(/\\/g, '/')
    if (!isAbsoluteImageUrl(id)) {
      const cloudUrl = cloudinaryDeliveryUrl(id)
      if (cloudUrl) return cloudUrl
    }
  }

  // Local disk only (Cloudinary not configured)
  const filename = file.filename || (file.path ? path.basename(file.path) : null)
  if (!filename) return null

  if (req?.get?.('host')) {
    const protocol = req.protocol || 'http'
    return `${protocol}://${req.get('host')}/uploads/${filename}`
  }

  return `/uploads/${filename}`
}
