export function success(res, data = null, httpStatus = 200) {
  return res.status(httpStatus).json({ success: true, data, error: null })
}

/**
 * @param {import('express').Response} res
 * @param {string} message
 * @param {number} httpStatus
 * @param {object} [extras] optional code/hint/retryable/details/fieldPaths for sync & validators
 */
export function error(res, message = 'Request failed', httpStatus = 400, extras = null) {
  const body = { success: false, data: null, error: message }
  if (extras && typeof extras === 'object') {
    if (extras.code != null) body.code = extras.code
    if (extras.retryable != null) body.retryable = extras.retryable
    if (extras.hint != null) body.hint = extras.hint
    if (extras.fieldPaths != null) body.fieldPaths = extras.fieldPaths
    if (extras.details != null) body.details = extras.details
  }
  return res.status(httpStatus).json(body)
}

export const fail = error

/**
 * Safe controller catch helper: 4xx keeps err.message; 5xx never leaks DB/stack detail.
 */
export function failFromError(res, err, fallbackMessage = 'Internal server error') {
  const status = Number(err?.status || err?.statusCode || 500)
  if (status >= 500) {
    console.error(err)
    return fail(res, fallbackMessage, status)
  }
  return fail(res, err?.message || fallbackMessage, status)
}
