// The master lists. Most live in their own table; the four downtime reason lists
// share downtime_reasons, one category each.
export interface MasterConfig {
  slug: string // URL part: /masters/<slug>
  table: string // database table
  title: string // page title
  singular: string // "Operator"
  nameLabel: string // label of the name field / column
  kind: 'simple' | 'machine'
  category?: 'Man' | 'Machine' | 'Material' | 'Others' // downtime_reasons rows of this group
}

export const MASTERS: MasterConfig[] = [
  { slug: 'machines', table: 'machines', title: 'Machines', singular: 'Machine', nameLabel: 'Machine Name', kind: 'machine' },
  { slug: 'operators', table: 'operators', title: 'Operators', singular: 'Operator', nameLabel: 'Operator Name', kind: 'simple' },
  { slug: 'supervisors', table: 'supervisors', title: 'Supervisors', singular: 'Supervisor', nameLabel: 'Supervisor Name', kind: 'simple' },
  { slug: 'qc-executives', table: 'qc_executives', title: 'QC Executives', singular: 'QC Executive', nameLabel: 'QC Executive Name', kind: 'simple' },
  { slug: 'units', table: 'units', title: 'Units', singular: 'Unit', nameLabel: 'Unit Name', kind: 'simple' },
  { slug: 'paper-types', table: 'paper_types', title: 'Paper Type', singular: 'Paper Type', nameLabel: 'Paper Type Name', kind: 'simple' },
  { slug: 'coatings', table: 'coatings', title: 'Coating', singular: 'Coating', nameLabel: 'Coating Name', kind: 'simple' },
  { slug: 'wastage-reasons', table: 'wastage_reasons', title: 'Wastage Reasons', singular: 'Wastage Reason', nameLabel: 'Wastage Reason', kind: 'simple' },
  { slug: 'downtime-man', table: 'downtime_reasons', category: 'Man', title: 'Downtime Reasons – Man', singular: 'Man reason', nameLabel: 'Reason', kind: 'simple' },
  { slug: 'downtime-machine', table: 'downtime_reasons', category: 'Machine', title: 'Downtime Reasons – Machine', singular: 'Machine reason', nameLabel: 'Reason', kind: 'simple' },
  { slug: 'downtime-material', table: 'downtime_reasons', category: 'Material', title: 'Downtime Reasons – Material', singular: 'Material reason', nameLabel: 'Reason', kind: 'simple' },
  { slug: 'downtime-others', table: 'downtime_reasons', category: 'Others', title: 'Downtime Reasons – Others', singular: 'Other reason', nameLabel: 'Reason', kind: 'simple' },
]

export function masterBySlug(slug: string): MasterConfig | undefined {
  return MASTERS.find((m) => m.slug === slug)
}

// A row from any master table. Machines also carry code and default_speed.
export interface MasterRow {
  id: string
  name: string
  active: boolean
  created_at: string
  updated_at: string
  code?: string
  default_speed?: number
  sort_order?: number
}
