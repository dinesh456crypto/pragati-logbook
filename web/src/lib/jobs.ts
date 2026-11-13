// Production Plan: planned jobs (Job Details).
export const JOB_TYPES = ['NPD', 'NEW', 'Re-Print'] as const
export type JobType = (typeof JOB_TYPES)[number]
export const MAX_COLOURS = 9

export interface Job {
  id: string
  plan_date: string // YYYY-MM-DD
  order_no: string
  job_name: string
  category: string | null
  ups: number
  job_type: JobType
  paper_type_id: string
  quantity: number
  colours: string[]
  created_at: string
  updated_at: string
  paper_types: { name: string } | null
}

export const JOB_COLUMNS =
  'id, plan_date, order_no, job_name, category, ups, job_type, paper_type_id, quantity, colours, created_at, updated_at, paper_types(name)'

// Tidies one typed value: trims and collapses repeated spaces.
export const tidy = (value: string) => value.trim().replace(/\s+/g, ' ')

// Turns the nine colour boxes into the saved list: empty boxes are skipped and a
// colour entered twice (ignoring case) is kept once. Also reports the repeats.
export function cleanColours(boxes: string[]): { colours: string[]; repeated: string[] } {
  const colours: string[] = []
  const repeated: string[] = []
  const seen = new Set<string>()
  for (const box of boxes) {
    const colour = tidy(box)
    if (!colour) continue
    const key = colour.toLowerCase()
    if (seen.has(key)) {
      if (!repeated.some((r) => r.toLowerCase() === key)) repeated.push(colour)
    } else {
      seen.add(key)
      colours.push(colour)
    }
  }
  return { colours, repeated }
}

// 2026-11-13 → 13-Nov-2026
export function formatDate(date: string | null | undefined): string {
  if (!date) return ''
  const [y, m, d] = date.slice(0, 10).split('-')
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]
  return month ? `${d}-${month}-${y}` : date
}

export const formatNumber = (n: number | null | undefined) => (n == null ? '' : n.toLocaleString('en-IN'))

// Text for a PostgREST "or" search: characters with special meaning there are
// turned into single-character wildcards so they still match.
export function searchPattern(text: string): string {
  return `*${tidy(text).replace(/[,()*%\\"._:]/g, '_')}*`
}
