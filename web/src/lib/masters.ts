// The ten master lists. Each lives in its own database table.
export interface MasterConfig {
  slug: string // URL part: /masters/<slug>
  table: string // database table
  title: string // page title
  singular: string // "Operator"
  nameLabel: string // label of the name field / column
  kind: 'simple' | 'machine'
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
  { slug: 'bdt-reasons', table: 'bdt_reasons', title: 'BDT Reasons', singular: 'BDT Reason', nameLabel: 'BDT Reason', kind: 'simple' },
  { slug: 'odt-reasons', table: 'odt_reasons', title: 'ODT Reasons', singular: 'ODT Reason', nameLabel: 'ODT Reason', kind: 'simple' },
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
