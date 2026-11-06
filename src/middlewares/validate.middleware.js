import { error } from '../utils/response.util.js'

// Drop body/query/params prefix so UI shows e.g. `categoryId: Invalid uuid`.
function formatIssue(issue) {
  if (!issue) return 'Validation failed'
  const path = Array.isArray(issue.path)
    ? issue.path.filter((part) => part !== 'body' && part !== 'query' && part !== 'params').join('.')
    : ''
  const message = issue.message || 'Validation failed'
  return path ? `${path}: ${message}` : message
}

export function validate(schema) {
  return (req, res, next) => {
    const parsed = schema.safeParse({
      body: req.body,
      query: req.query,
      params: req.params,
    })

    if (!parsed.success) {
      // Log full Zod issues for server-side debugging of 422s
      console.warn('[validate] 422', JSON.stringify(parsed.error.issues))
      return error(res, formatIssue(parsed.error.issues?.[0]), 422)
    }

    req.validated = parsed.data
    next()
  }
}
