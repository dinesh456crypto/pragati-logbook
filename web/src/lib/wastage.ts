// Wastage Management: one wastage record per production order, after production.

export const UNITS = ['pcs', 'sheets'] as const
export const unitLabel = (u: string) => (u === 'sheets' ? 'Sheets' : 'Pcs')
export type Unit = (typeof UNITS)[number]

export interface WastageLine {
  line?: number
  process: string
  defect: string
  reason: string
  quantity: string
  unit: Unit
}

export interface WastageRecord {
  id: string
  record_no: number
  order_no: string
  order_key: string
  job_name: string | null
  ups: number | null
  given_sheets: number
  ok_sheets: number
  separate_sheets: number
  production_wastage: number
  production_entries: number
  order_qty: number
  packed_qty: number
  remarks: string | null
  created_by_name: string | null
  updated_by_name: string | null
  created_at: string
  updated_at: string
}

export interface ProductionTotals {
  order_no: string
  job_id: string | null
  job_name: string | null
  ups: number | null
  entries: number
  given_sheets: number
  ok_sheets: number
  separate_sheets: number
  production_wastage: number
  last_production_date: string | null
  fully_closed: boolean
  sides: { side: string; entries: number; given: number; ok: number; separate: number; wastage: number }[]
}

export const RECORD_COLUMNS =
  'id, record_no, order_no, order_key, job_name, ups, given_sheets, ok_sheets, separate_sheets, production_wastage, production_entries, order_qty, packed_qty, remarks, created_by_name, updated_by_name, created_at, updated_at'

export const wastageLabel = (n: number | null | undefined) => (n ? `WE-${String(n).padStart(5, '0')}` : 'New record')

export const emptyLine = (): WastageLine => ({ process: '', defect: '', reason: '', quantity: '', unit: 'pcs' })

// Total wastage per unit, and everything expressed in Pcs (1 sheet = UPS Pcs).
export function lineTotals(lines: { quantity: string | number; unit: string }[], ups: number | null) {
  let pcs = 0
  let sheets = 0
  for (const l of lines) {
    const q = Number(l.quantity) || 0
    if (l.unit === 'sheets') sheets += q
    else pcs += q
  }
  return { pcs, sheets, inPcs: ups ? pcs + sheets * ups : null }
}
