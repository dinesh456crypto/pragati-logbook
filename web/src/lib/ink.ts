// Ink Formula Management: one formula record per planned order, with revisions.

export interface InkColour {
  colour: string
  sides: string[]
  formula: string | null
}

export interface InkRecord {
  id: string
  record_no: number
  job_id: string | null
  order_no: string
  order_key: string
  job_name: string | null
  category: string | null
  plan_date: string | null
  revision: number
  archived: boolean
  created_by_name: string | null
  updated_by_name: string | null
  created_at: string
  updated_at: string
}

export interface InkRevision {
  id: string
  revision: number
  colours: InkColour[]
  note: string | null
  changed_by_name: string | null
  changed_at: string
}

export const RECORD_COLUMNS =
  'id, record_no, job_id, order_no, order_key, job_name, category, plan_date, revision, archived, created_by_name, updated_by_name, created_at, updated_at'

export const formulaLabel = (n: number | null | undefined) => (n ? `IF-${String(n).padStart(5, '0')}` : 'New formula')

export const sideText = (sides: string[]) => (sides.length ? sides.join(', ') : '—')
