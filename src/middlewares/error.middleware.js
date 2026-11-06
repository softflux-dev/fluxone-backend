import multer from 'multer'
import { error } from '../utils/response.util.js'

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

function mapUploadError(err) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return { status: 413, message: 'Image must be under 10 MB (JPEG, PNG, or WebP)' }
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return { status: 400, message: 'Unexpected file field in upload' }
    }
    return { status: 400, message: err.message || 'Invalid file upload' }
  }

  if (err.message === 'Only JPEG, PNG, or WebP images are allowed') {
    return { status: 400, message: err.message }
  }

  const message = String(err.message || '')
  const storageErrors = Array.isArray(err.storageErrors) ? err.storageErrors : []

  if (
    storageErrors.length > 0 ||
    message.includes('Missing required parameter') ||
    message.includes('cloudinary') ||
    message.includes('Cloudinary') ||
    err.name === 'StorageError'
  ) {
    return {
      status: 502,
      message:
        'Image upload failed. Ensure Cloudinary is configured with Upload/Create permission on the server.',
    }
  }

  return null
}

export function errorMiddleware(err, _req, res, _next) {
  const uploadError = mapUploadError(err)
  if (uploadError) {
    return error(res, uploadError.message, uploadError.status)
  }

  const status = err.status || err.statusCode || 500
  // Never leak DB/stack detail on 5xx (even outside production)
  const message =
    status >= 500 ? 'Internal server error' : err.message || 'Internal server error'

  if (status >= 500) {
    console.error(err)
  }

  // Pass through structured sync/validation metadata on 4xx so POS can fix easily
  const extras =
    status < 500 && (err.code || err.hint || err.details || err.fieldPaths || err.retryable != null)
      ? {
          ...(err.code != null ? { code: err.code } : {}),
          ...(err.retryable != null ? { retryable: err.retryable } : {}),
          ...(err.hint != null ? { hint: err.hint } : {}),
          ...(err.fieldPaths != null ? { fieldPaths: err.fieldPaths } : {}),
          ...(err.details != null
            ? {
                details: {
                  formErrors: err.details.formErrors,
                  fieldErrors: err.details.fieldErrors,
                  issues: err.details.issues,
                },
              }
            : {}),
        }
      : null

  return error(res, message, status, extras)
}

export function notFoundMiddleware(req, res) {
  return error(res, `Route not found: ${req.method} ${req.originalUrl}`, 404)
}
