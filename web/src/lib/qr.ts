// Job card QR codes: one "Label: value" per line, for example
//   Production Order Number: 422601035/6
//   Machine: 2KM740CX
//   Print Side: F/S + B/S
//   Front C: Yes ... Front Other Colours: S1, S2, S3
//   B/S C: Yes ... B/S Other Colours: S1, S2, S3
// Labels are matched without case, spaces or punctuation. A plain barcode (only the
// production order number) is still accepted everywhere a QR is.

export interface QrSide {
  print_side: string // O/S, F/S, B/S, B/B F or B/B B
  colours: string[]
}

export interface QrJob {
  order_no: string
  plan_date?: string // yyyy-mm-dd
  machine?: string
  cso_no?: string
  job_name?: string
  category?: string
  ups?: string
  job_type?: string
  paper?: string
  coating?: string
  quantity?: string
  print_side?: string // as written: O/S, F/S, B/S, F/S + B/S, B/B
  sides: QrSide[] // slots to plan, with their colours
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const EMPTY = new Set(['', '-', '—', '–', 'na', 'n/a', 'nil', 'none'])
const clean = (v: string | undefined) => {
  const t = (v ?? '').trim().replace(/\s+/g, ' ')
  return EMPTY.has(t.toLowerCase()) ? undefined : t
}
const yes = (v: string | undefined) => /^(yes|y|true|1|✓|✔)$/i.test((v ?? '').trim())
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n: number) => String(n).padStart(2, '0')

// 29-Aug-2026, 29 Aug 2026, 29-08-2026, 29/08/2026 or 2026-08-29 → 2026-08-29.
export function qrDate(text: string | undefined): string | undefined {
  const t = clean(text)
  if (!t) return undefined
  let d = 0
  let m = 0
  let y = 0
  let x = t.match(/^(\d{1,2})[-/. ]([A-Za-z]{3,9})[-/. ,]+(\d{4})$/)
  if (x) [d, m, y] = [Number(x[1]), MONTHS.indexOf(x[2].slice(0, 3).toLowerCase()) + 1, Number(x[3])]
  else if ((x = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [d, m, y] = [Number(x[1]), Number(x[2]), Number(x[3])]
  else if ((x = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) [y, m, d] = [Number(x[1]), Number(x[2]), Number(x[3])]
  else return undefined
  const check = new Date(Date.UTC(y, m - 1, d))
  if (!m || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return undefined
  return `${y}-${pad(m)}-${pad(d)}`
}

function sideColours(v: Map<string, string>, prefix: 'front' | 'bs'): string[] {
  const list = ['C', 'M', 'Y', 'K'].filter((c) => yes(v.get(prefix + c.toLowerCase())))
  const other = clean(v.get(prefix + 'othercolours') ?? v.get(prefix + 'othercolors') ?? v.get(prefix + 'colours'))
  for (const c of (other ?? '').split(/[,;]/)) {
    const t = c.trim().replace(/\s+/g, ' ')
    if (t && !list.some((x) => x.toLowerCase() === t.toLowerCase())) list.push(t)
  }
  return list
}

// Reads a job card QR. Returns null when the text is not one (e.g. a plain barcode).
export function parseQrJob(text: string): QrJob | null {
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    values.set(key(line.slice(0, i)), line.slice(i + 1))
  }
  const order = clean(values.get('productionordernumber') ?? values.get('productionorderno') ?? values.get('ordernumber'))
  if (!order || values.size < 2) return null
  const side = clean(values.get('printside'))
  const front = sideColours(values, 'front')
  const back = sideColours(values, 'bs')
  const s = key(side ?? '')
  const sides: QrSide[] =
    s === 'os'
      ? [{ print_side: 'O/S', colours: front }]
      : s === 'fs'
        ? [{ print_side: 'F/S', colours: front }]
        : s === 'bs'
          ? [{ print_side: 'B/S', colours: back.length ? back : front }]
          : s === 'fsbs'
            ? [{ print_side: 'F/S', colours: front }, { print_side: 'B/S', colours: back }]
            : s === 'bb' || s === 'bbf' || s === 'bbb' || s === 'bbfbbb'
              ? [{ print_side: 'B/B F', colours: front }, { print_side: 'B/B B', colours: front }]
              : []
  return {
    order_no: order.slice(0, 60),
    plan_date: qrDate(values.get('date') ?? values.get('plandate')),
    machine: clean(values.get('machine') ?? values.get('machineid')),
    cso_no: clean(values.get('csonumber') ?? values.get('cso')),
    job_name: clean(values.get('jobname')),
    category: clean(values.get('category')),
    ups: clean(values.get('ups'))?.replace(/[^0-9]/g, '') || undefined,
    job_type: clean(values.get('jobtype')),
    paper: clean(values.get('typeofpaper') ?? values.get('papertype') ?? values.get('paper')),
    coating: clean(values.get('coating')),
    quantity: clean(values.get('quantitysheets') ?? values.get('quantity'))?.replace(/[^0-9]/g, '') || undefined,
    print_side: side,
    sides,
  }
}

// The production order number in a scan: from a QR, or the whole text of a plain barcode.
export const scannedOrderNo = (text: string, qr: QrJob | null) => (qr ? qr.order_no : text.trim().replace(/\s+/g, ' ').slice(0, 60))

// Finds a master row by name (case and spaces ignored); machines also by Machine ID.
export function matchMaster<T extends { id: string; name: string; active: boolean; code?: string }>(
  rows: T[],
  value: string | undefined,
): T | undefined {
  if (!value) return undefined
  const k = key(value)
  const hits = rows.filter((r) => (r.code !== undefined && key(r.code) === k) || key(r.name) === k)
  return hits.find((r) => r.code !== undefined && key(r.code) === k && r.active) ?? hits.find((r) => r.active) ?? hits[0]
}
