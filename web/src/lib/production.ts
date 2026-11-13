// Production Entry: form state, time helpers and the rules the screen shows live.
// The database re-checks every rule when an entry is saved.
import { PLANT_TIMEZONE, addDays, plantDate } from './dates'

export const PRINT_SIDES = ['O/S', 'F/S', 'B/S', 'B/B F', 'B/B B'] as const
export const SHIFTS = ['A', 'B'] as const
export const HELPERS = ['1', '2', '3', '4'] as const
export const UNIT_COUNT = 7

export const ACTIVITIES = [
  { key: 'make_ready', label: 'Make Ready' },
  { key: 'registration', label: 'Registration' },
  { key: 'colour_matching', label: 'Colour Matching' },
] as const
export type ActivityKey = (typeof ACTIVITIES)[number]['key'] | 'run'

export const SECTIONS = [
  'Job Details',
  'Worker Details',
  'Unit-wise Colour Allocation',
  'Changeover Time',
  'Run Time',
  'Downtime (BDT / ODT)',
  'Production Details',
] as const

// Changeover and production steps, in the order they happen on the machine.
export const STEPS = ['make_ready', 'registration', 'colour_matching', 'run'] as const
export type StepKey = (typeof STEPS)[number]
export const STEP_LABEL: Record<StepKey, string> = {
  make_ready: 'Make Ready',
  registration: 'Registration',
  colour_matching: 'Colour Matching',
  run: 'Production',
}

// Which section shows each field (used to point at errors).
const FIELD_SECTION: Record<string, number> = {
  production_date: 0, machine_id: 0, shift: 0, order_no: 0, job_name: 0, category: 0, ups: 0, job_type: 0,
  paper_type_id: 0, planned_quantity: 0, print_side: 0, continuing: 0,
  operator_id: 1, supervisor_id: 1, qc_executive_id: 1, helpers: 1,
  planned_colours: 2, unit_colours: 2, coating_id: 2, colour_changes: 2, coating_changed: 2,
  make_ready: 3, registration: 3, colour_matching: 3,
  run: 4,
  downtime: 5,
  machine_speed: 6, total_sheets: 6, ok_sheets: 6, separate_sheets: 6, wastage: 6, remarks: 6,
}
export const sectionOf = (field: string | null | undefined) => (field ? (FIELD_SECTION[field] ?? 0) : 0)

export interface FieldError {
  field: string | null
  message: string
}

// A moment entered as plant date + time (strings, as the inputs hold them).
export interface Stamp {
  date: string // YYYY-MM-DD
  time: string // HH:MM (24-hour, as the time input stores it)
}
export interface Span {
  start: Stamp
  end: Stamp
}
const emptyStamp = (): Stamp => ({ date: '', time: '' })
export const emptySpan = (): Span => ({ start: emptyStamp(), end: emptyStamp() })

export interface WastageRow {
  quantity: string
  reason_id: string
}

export interface DowntimeRow {
  kind: '' | 'BDT' | 'ODT'
  reason_id: string
  span: Span
  remarks: string
}
export const emptyDowntime = (): DowntimeRow => ({ kind: '', reason_id: '', span: emptySpan(), remarks: '' })

export interface EntryState {
  production_date: string
  machine_id: string
  shift: string
  order_no: string
  job_name: string
  category: string
  ups: string
  job_type: string
  paper_type_id: string
  planned_quantity: string
  print_side: string
  continuing: boolean
  operator_id: string
  supervisor_id: string
  qc_executive_id: string
  helpers: string
  planned_colours: string[] // the job's colours for the chosen print side
  unit_colours: string[] // seven units
  coating_id: string
  colour_changes: string
  coating_changed: string // '' | 'yes' | 'no'
  make_ready: Span
  registration: Span
  colour_matching: Span
  run: Span
  machine_speed: string
  total_sheets: string
  ok_sheets: string
  separate_sheets: string
  wastage: WastageRow[]
  downtime: DowntimeRow[]
  manual_starts: StepKey[] // start times typed by hand (not following the previous step)
  remarks: string
}

// Default production date: B shift before 08:00 belongs to the previous day.
export function defaultProductionDate(shift: string, at: Date = new Date()): string {
  const today = plantDate(at)
  return shift === 'B' && plantStamp(at).time < '08:00' ? addDays(today, -1) : today
}

export function currentShift(at: Date = new Date()): 'A' | 'B' {
  const t = plantStamp(at).time
  return t >= '08:00' && t < '16:30' ? 'A' : 'B'
}

export function newEntryState(): EntryState {
  const shift = currentShift()
  return {
    production_date: defaultProductionDate(shift),
    machine_id: '',
    shift,
    order_no: '',
    job_name: '',
    category: '',
    ups: '',
    job_type: '',
    paper_type_id: '',
    planned_quantity: '',
    print_side: '',
    continuing: false,
    operator_id: '',
    supervisor_id: '',
    qc_executive_id: '',
    helpers: '',
    planned_colours: Array(7).fill(''),
    unit_colours: Array(UNIT_COUNT).fill(''),
    coating_id: '',
    colour_changes: '',
    coating_changed: '',
    make_ready: emptySpan(),
    registration: emptySpan(),
    colour_matching: emptySpan(),
    run: emptySpan(),
    machine_speed: '',
    total_sheets: '',
    ok_sheets: '',
    separate_sheets: '',
    wastage: [{ quantity: '', reason_id: '' }],
    downtime: [],
    manual_starts: [],
    remarks: '',
  }
}

// ---- Plant time ----------------------------------------------------------------

// The plant date and HH:MM for a moment.
export function plantStamp(at: Date): Stamp {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: PLANT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` }
}

export const nowStamp = () => plantStamp(new Date())

// Plant date + time → ISO moment (India has no daylight saving, so +05:30 always).
export function stampToIso(s: Stamp): string | null {
  return s.date && s.time ? `${s.date}T${s.time}:00+05:30` : null
}
export function isoToStamp(iso: string | null | undefined): Stamp {
  return iso ? plantStamp(new Date(iso)) : emptyStamp()
}
export const stampMs = (s: Stamp) => {
  const iso = stampToIso(s)
  return iso ? Date.parse(iso) : null
}
const ms = stampMs

export const stampFilled = (s: Stamp) => Boolean(s.date && s.time)
export const stampPartial = (s: Stamp) => Boolean(s.date) !== Boolean(s.time)
export const spanTouched = (s: Span) => Boolean(s.start.date || s.start.time || s.end.date || s.end.time)
export const spanComplete = (s: Span) => stampFilled(s.start) && stampFilled(s.end) && (spanMinutes(s) ?? -1) >= 0

// Minutes from start to end; null when either is missing, negative when reversed.
export function spanMinutes(s: Span): number | null {
  const a = ms(s.start)
  const b = ms(s.end)
  return a === null || b === null ? null : Math.round((b - a) / 60000)
}

export function compareStamps(a: Stamp, b: Stamp): number {
  return (ms(a) ?? 0) - (ms(b) ?? 0)
}

// ---- Sequential steps and automatic start times -----------------------------------

// Each step starts when the one before it ended; the first starts when the machine
// became ready. Changeover steps that are not in use are skipped. Starts typed by
// hand are kept.
export function applyAutoStarts(st: EntryState, readyAt: Stamp | null, changeoverInUse: boolean): EntryState {
  let chain: Stamp | null = readyAt && stampFilled(readyAt) ? readyAt : null
  let next = st
  for (const key of STEPS) {
    const span = next[key]
    const inUse = key === 'run' || changeoverInUse || stampFilled(span.end) || stampFilled(span.start)
    if (inUse && !next.manual_starts.includes(key) && chain) {
      if (span.start.date !== chain.date || span.start.time !== chain.time) {
        next = { ...next, [key]: { ...span, start: { ...chain } } }
      }
    }
    const cur = next[key]
    if (stampFilled(cur.end)) chain = cur.end
    else if (stampFilled(cur.start) && key !== 'run') chain = null // step still running: the next one waits
  }
  return next
}

// The automatic start of a step (what applyAutoStarts would use), for "reset" buttons.
export function autoStartOf(st: EntryState, key: StepKey, readyAt: Stamp | null): Stamp | null {
  let chain: Stamp | null = readyAt && stampFilled(readyAt) ? readyAt : null
  for (const k of STEPS) {
    if (k === key) return chain
    const span = st[k]
    if (stampFilled(span.end)) chain = span.end
  }
  return null
}

// ---- Downtime overlap (merged, so a minute is never counted twice) -----------------

type Interval = [number, number]
function mergedDowntime(rows: DowntimeRow[]): Interval[] {
  const list = rows
    .map((r) => [stampMs(r.span.start), stampMs(r.span.end)] as const)
    .filter((x): x is [number, number] => x[0] !== null && x[1] !== null && x[1] > x[0])
    .sort((a, b) => a[0] - b[0])
  const out: Interval[] = []
  for (const [a, b] of list) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

// True when two downtime rows overlap (a machine has one BDT or ODT at a time).
export function downtimeOverlaps(rows: DowntimeRow[]): boolean {
  const list = rows
    .map((r) => [stampMs(r.span.start), stampMs(r.span.end) ?? Infinity] as const)
    .filter((x): x is [number, number] => x[0] !== null && x[1] > x[0])
    .sort((a, b) => a[0] - b[0])
  return list.some((x, i) => i > 0 && x[0] < list[i - 1][1])
}

export function overlapMinutes(rows: DowntimeRow[], span: Span): number {
  const a = stampMs(span.start)
  const b = stampMs(span.end)
  if (a === null || b === null || b <= a) return 0
  const ms = mergedDowntime(rows).reduce((sum, [x, y]) => sum + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0)
  return ms / 60000
}

export interface StepTimes {
  gross: number | null
  net: number | null
  downtime: number
}
export function stepTimes(st: EntryState, key: StepKey): StepTimes {
  const span = st[key]
  const gross = spanMinutes(span)
  if (gross === null || gross < 0) return { gross: null, net: null, downtime: 0 }
  const down = overlapMinutes(st.downtime, span)
  return { gross, net: Math.round(gross - down), downtime: Math.round(down) }
}

export function changeoverTotals(st: EntryState): { gross: number | null; net: number | null } {
  const parts = ACTIVITIES.map((a) => stepTimes(st, a.key))
  if (parts.every((p) => p.gross === null)) return { gross: null, net: null }
  return {
    gross: parts.reduce((s, p) => s + (p.gross ?? 0), 0),
    net: parts.reduce((s, p) => s + (p.net ?? 0), 0),
  }
}

// Which steps a downtime row falls in, e.g. "Make Ready 15 min · Registration 5 min".
export function downtimePlacement(st: EntryState, row: DowntimeRow): string {
  const parts = STEPS.map((k) => ({ k, m: Math.round(overlapMinutes([row], st[k])) })).filter((x) => x.m > 0)
  return parts.map((x) => `${STEP_LABEL[x.k]} ${x.m} min`).join(' · ')
}

// 14:05 → 2:05 PM
export function time12(hhmm: string): string {
  if (!hhmm) return ''
  const [h, m] = hhmm.split(':').map(Number)
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

export function formatMoment(iso: string | null | undefined): string {
  if (!iso) return ''
  const s = plantStamp(new Date(iso))
  const [y, mo, d] = s.date.split('-')
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mo) - 1]
  return `${d}-${month}-${y} ${time12(s.time)}`
}

export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null) return '—'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h} h ${m} min` : `${m} min`
}

export const entryLabel = (n: number | null | undefined) => (n ? `PE-${String(n).padStart(5, '0')}` : 'New entry')

// ---- Rules shown live ---------------------------------------------------------

export function changeoverRequired(side: string, continuing: boolean, isFirst: boolean): boolean {
  return side === 'B/B F' || side === 'B/B B' ? isFirst : !continuing
}

export const sideFamily = (side: string) =>
  side === 'O/S' ? 'O/S' : side === 'F/S' || side === 'B/S' ? 'F/S + B/S' : side.startsWith('B/B') ? 'B/B F + B/B B' : ''

export const int = (v: string) => (v.trim() === '' ? null : Number(v))

export function wastageTotal(rows: WastageRow[]): number {
  return rows.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0)
}

// ---- Converting to and from the database ---------------------------------------

export function toPayload(st: EntryState) {
  const downtime = st.downtime
    .filter((d) => d.kind || d.reason_id || spanTouched(d.span) || d.remarks.trim())
    .map((d) => ({
      kind: d.kind || null,
      reason_id: d.reason_id || null,
      start_at: stampToIso(d.span.start),
      end_at: stampToIso(d.span.end),
      remarks: d.remarks,
    }))
  const entry = {
    production_date: st.production_date,
    machine_id: st.machine_id,
    shift: st.shift,
    order_no: st.order_no,
    job_name: st.job_name,
    category: st.category,
    ups: int(st.ups),
    job_type: st.job_type,
    paper_type_id: st.paper_type_id,
    planned_quantity: int(st.planned_quantity),
    planned_colours: st.planned_colours.map((c) => c.trim()).filter(Boolean),
    print_side: st.print_side,
    continuing: st.continuing,
    operator_id: st.operator_id,
    supervisor_id: st.supervisor_id,
    qc_executive_id: st.qc_executive_id,
    helpers: int(st.helpers),
    unit_colours: st.unit_colours.map((c) => c || null),
    coating_id: st.coating_id,
    colour_changes: int(st.colour_changes),
    coating_changed: st.coating_changed === '' ? null : st.coating_changed === 'yes',
    make_ready_start: stampToIso(st.make_ready.start),
    make_ready_end: stampToIso(st.make_ready.end),
    registration_start: stampToIso(st.registration.start),
    registration_end: stampToIso(st.registration.end),
    colour_matching_start: stampToIso(st.colour_matching.start),
    colour_matching_end: stampToIso(st.colour_matching.end),
    run_start: stampToIso(st.run.start),
    run_end: stampToIso(st.run.end),
    machine_speed: int(st.machine_speed),
    total_sheets: int(st.total_sheets),
    ok_sheets: int(st.ok_sheets),
    separate_sheets: int(st.separate_sheets),
    remarks: st.remarks,
    manual_starts: st.manual_starts,
  }
  const wastage = st.wastage
    .filter((w) => w.quantity.trim() || w.reason_id)
    .map((w) => ({ quantity: int(w.quantity), reason_id: w.reason_id || null }))
  return { entry, wastage, downtime }
}

export interface EntryRow {
  id: string
  entry_no: number
  status: 'draft' | 'submitted'
  machine_id: string
  production_date: string
  shift: string | null
  order_no: string | null
  order_key: string | null
  job_id: string | null
  job_name: string | null
  category: string | null
  ups: number | null
  job_type: string | null
  paper_type_id: string | null
  planned_quantity: number | null
  planned_colours: string[]
  print_side: string | null
  continuing: boolean
  continues_entry_id: string | null
  operator_id: string | null
  supervisor_id: string | null
  qc_executive_id: string | null
  helpers: number | null
  unit_colours: (string | null)[]
  coating_id: string | null
  colour_changes: number | null
  coating_changed: boolean | null
  make_ready_start: string | null
  make_ready_end: string | null
  registration_start: string | null
  registration_end: string | null
  colour_matching_start: string | null
  colour_matching_end: string | null
  run_start: string | null
  run_end: string | null
  changeover_gross_minutes: number | null
  changeover_net_minutes: number | null
  run_minutes: number | null
  run_net_minutes: number | null
  downtime_minutes: number
  manual_starts: string[]
  previous_entry_id: string | null
  machine_ready_at: string | null
  machine_speed: number | null
  total_sheets: number | null
  ok_sheets: number | null
  separate_sheets: number | null
  wastage_sheets: number
  remarks: string | null
  submitted_at: string | null
  created_at: string
  created_by: string | null
  updated_at: string
}

const str = (v: number | string | null | undefined) => (v == null ? '' : String(v))
const span = (a: string | null, b: string | null): Span => ({ start: isoToStamp(a), end: isoToStamp(b) })

export interface DowntimeDbRow {
  kind: 'BDT' | 'ODT'
  start_at: string | null
  end_at: string | null
  bdt_reason_id: string | null
  odt_reason_id: string | null
  remarks: string | null
}

export function fromRow(
  r: EntryRow,
  wastage: { quantity: number | null; reason_id: string | null }[],
  downtime: DowntimeDbRow[] = [],
): EntryState {
  const colours = [...(r.planned_colours ?? [])]
  return {
    production_date: r.production_date,
    machine_id: r.machine_id,
    shift: str(r.shift),
    order_no: str(r.order_no),
    job_name: str(r.job_name),
    category: str(r.category),
    ups: str(r.ups),
    job_type: str(r.job_type),
    paper_type_id: str(r.paper_type_id),
    planned_quantity: str(r.planned_quantity),
    print_side: str(r.print_side),
    continuing: r.continuing,
    operator_id: str(r.operator_id),
    supervisor_id: str(r.supervisor_id),
    qc_executive_id: str(r.qc_executive_id),
    helpers: str(r.helpers),
    planned_colours: Array.from({ length: Math.max(7, colours.length) }, (_, i) => colours[i] ?? ''),
    unit_colours: Array.from({ length: UNIT_COUNT }, (_, i) => r.unit_colours?.[i] ?? ''),
    coating_id: str(r.coating_id),
    colour_changes: str(r.colour_changes),
    coating_changed: r.coating_changed == null ? '' : r.coating_changed ? 'yes' : 'no',
    make_ready: span(r.make_ready_start, r.make_ready_end),
    registration: span(r.registration_start, r.registration_end),
    colour_matching: span(r.colour_matching_start, r.colour_matching_end),
    run: span(r.run_start, r.run_end),
    machine_speed: str(r.machine_speed),
    total_sheets: str(r.total_sheets),
    ok_sheets: str(r.ok_sheets),
    separate_sheets: str(r.separate_sheets),
    wastage: wastage.length
      ? wastage.map((w) => ({ quantity: str(w.quantity), reason_id: str(w.reason_id) }))
      : [{ quantity: '', reason_id: '' }],
    downtime: downtime.map((d) => ({
      kind: d.kind,
      reason_id: str(d.kind === 'BDT' ? d.bdt_reason_id : d.odt_reason_id),
      span: span(d.start_at, d.end_at),
      remarks: str(d.remarks),
    })),
    manual_starts: (r.manual_starts ?? []).filter((k): k is StepKey => (STEPS as readonly string[]).includes(k)),
    remarks: str(r.remarks),
  }
}

// What the server tells the form about an order on a machine.
export interface SideColours {
  print_side: string
  colours: string[]
}
export interface OrderJob {
  id?: string
  order_no: string
  job_name: string
  category: string | null
  ups: number | null
  job_type: string | null
  paper_type_id: string | null
  quantity: number | null
  sides: SideColours[]
}
export interface SideStatus {
  side: string
  entries: number
  ok_sheets: number | null
  total_sheets: number | null
  closed: boolean
}
export interface OrderStatus {
  order_key?: string
  job?: OrderJob | null
  last_entry_job?: OrderJob | null
  sides?: SideStatus[]
  closed_sides?: string[]
  fully_closed?: boolean
  is_first?: boolean
  previous_on_machine?: {
    id: string
    entry_no: number
    print_side: string | null
    production_date: string
    shift: string | null
    run_end: string | null
  } | null
}

export interface Timeline {
  previous: { id: string; entry_no: number; order_no: string | null; job_name: string | null; print_side: string | null; run_end: string } | null
  downtime: { id: string; kind: 'BDT' | 'ODT'; start_at: string; end_at: string; minutes: number; reason: string | null }[]
  open_downtime: { id: string; kind: 'BDT' | 'ODT'; start_at: string }[]
  ready_at: string | null
}

export interface OrderOption {
  order_no: string
  job_name: string | null
  plan_date: string | null
  planned: boolean
  sides_used: string[]
  sides_closed: string[]
}
