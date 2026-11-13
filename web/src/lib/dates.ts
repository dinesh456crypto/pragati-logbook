// The plant runs on India time regardless of the device's timezone setting.
export const PLANT_TIMEZONE = 'Asia/Kolkata'

// YYYY-MM-DD for a moment in plant time.
export function plantDate(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PLANT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

// Adds whole days to a YYYY-MM-DD date.
export function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

export function formatMinutes(total: number): string {
  const n = Math.max(0, Math.round(total || 0))
  const h = Math.floor(n / 60)
  const m = n % 60
  return h ? `${h}h ${m}m` : `${m} min`
}
