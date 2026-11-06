// Rating bands frozen at score time (TL: Excellent / Good / Fair / Poor)

export function ratingLabelFromScore(score) {
  const value = Number(score)
  if (!Number.isFinite(value)) return 'Poor'
  if (value >= 80) return 'Excellent'
  if (value >= 60) return 'Good'
  if (value >= 40) return 'Fair'
  return 'Poor'
}

export function slugifyCriterion(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '_')
    .replace(/^-+|-+$/g, '')
}
