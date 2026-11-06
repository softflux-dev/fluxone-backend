import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import multer from 'multer'
import FileType from 'file-type'
import { cloudinary, isCloudinaryConfigured } from '../config/cloudinary.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const localUploadsDir = path.resolve(__dirname, '../../uploads')

const allowedMimes = new Set(['image/jpeg', 'image/png', 'image/webp'])
const mimeToExt = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}

function clientMimeFilter(_req, file, cb) {
  // First gate — client Content-Type (spoofable); magic bytes checked in storage
  if (!allowedMimes.has(file.mimetype)) {
    cb(new Error('Only JPEG, PNG, or WebP images are allowed'))
    return
  }
  cb(null, true)
}

function readStreamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

function uploadBufferToCloudinary(buffer, mime) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'fluxone',
        resource_type: 'image',
        allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
        format: mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg',
      },
      (err, result) => {
        if (err) reject(err)
        else resolve(result)
      },
    )
    stream.end(buffer)
  })
}

// Custom storage: buffer → magic-byte check → Cloudinary or local disk
function secureImageStorage() {
  return {
    _handleFile(req, file, cb) {
      ;(async () => {
        const buffer = await readStreamToBuffer(file.stream)

        // Magic-byte detection (ignores spoofed Content-Type)
        const detected = await FileType.fromBuffer(buffer)
        if (!detected || !allowedMimes.has(detected.mime)) {
          throw new Error('Only JPEG, PNG, or WebP images are allowed')
        }

        file.mimetype = detected.mime
        const ext = mimeToExt[detected.mime] || `.${detected.ext}`

        if (isCloudinaryConfigured()) {
          // Upload only after content is verified
          const result = await uploadBufferToCloudinary(buffer, detected.mime)
          cb(null, {
            path: result.secure_url,
            filename: result.public_id,
            public_id: result.public_id,
            secure_url: result.secure_url,
            url: result.secure_url,
            size: buffer.length,
            mimetype: detected.mime,
          })
          return
        }

        // Local disk fallback
        if (!fs.existsSync(localUploadsDir)) {
          fs.mkdirSync(localUploadsDir, { recursive: true })
        }
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
        const dest = path.join(localUploadsDir, filename)
        await fs.promises.writeFile(dest, buffer)
        cb(null, {
          path: dest,
          filename,
          size: buffer.length,
          mimetype: detected.mime,
        })
      })().catch((err) => cb(err))
    },
    _removeFile(_req, file, cb) {
      if (!file?.path || /^https?:\/\//i.test(file.path)) {
        cb(null)
        return
      }
      fs.unlink(file.path, () => cb(null))
    },
  }
}

export const upload = multer({
  storage: secureImageStorage(),
  fileFilter: clientMimeFilter,
  limits: { fileSize: 10 * 1024 * 1024 },
})
