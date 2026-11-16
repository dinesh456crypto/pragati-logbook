// Job Details bulk upload: the Excel template, reading an uploaded file, and the
// row checks. The database checks every row again (import_production_jobs) and
// saves all rows or none.
import type { Workbook, Worksheet } from 'exceljs'
import { JOB_TYPES } from './jobs'

export const MAX_ROWS = 500
export const UPLOAD_SIDES = ['O/S', 'F/S', 'B/S', 'F/S + B/S', 'B/B'] as const

interface Column {
  key: keyof UploadRow
  header: string
  width: number
  required: boolean
  note: string
  example: string | number
}

export const COLUMNS: Column[] = [
  { key: 'plan_date', header: 'Date', width: 14, required: true, note: 'Production plan date. Type as dd-mm-yyyy (e.g. 16-11-2026) or pick a date.', example: '16-11-2026' },
  { key: 'order_no', header: 'Order Number', width: 18, required: true, note: 'Up to 60 characters. Must be new: not already planned and not repeated in this file.', example: 'PO-2026-0451' },
  { key: 'job_name', header: 'Job Name', width: 34, required: true, note: 'Up to 150 characters.', example: 'Sweet Box 500g' },
  { key: 'category', header: 'Category', width: 18, required: true, note: 'Up to 80 characters. Required.', example: 'Carton' },
  { key: 'ups', header: 'UPS', width: 9, required: true, note: 'Whole number above 0.', example: 6 },
  { key: 'job_type', header: 'Job Type', width: 13, required: true, note: 'Choose from the list: NPD, NEW, Re-Print.', example: 'NEW' },
  { key: 'paper_type', header: 'Type of Paper', width: 18, required: true, note: 'Choose from the list (your Paper Type master).', example: '' },
  { key: 'quantity', header: 'Quantity (Sheets)', width: 17, required: true, note: 'Whole number of sheets above 0.', example: 12000 },
  { key: 'print_side', header: 'Print Side', width: 13, required: true, note: 'O/S, F/S, B/S, F/S + B/S, or B/B (B/B plans B/B F and B/B B together).', example: 'F/S + B/S' },
  { key: 'colours', header: 'Colours', width: 38, required: true, note: 'Colours of the printed side, separated by commas. E.g. C, M, Y, K, PMS 185. For "F/S + B/S" these are the F/S colours.', example: 'C, M, Y, K, PMS 185' },
  { key: 'bs_colours', header: 'B/S Colours', width: 30, required: false, note: 'Only when Print Side is "F/S + B/S": the back-side colours, separated by commas. Leave empty otherwise.', example: 'K, PMS 286' },
]

export interface UploadRow {
  row: number
  plan_date: string
  order_no: string
  job_name: string
  category: string
  ups: string
  job_type: string
  paper_type: string
  quantity: string
  print_side: string
  colours: string
  bs_colours: string
}

export interface RowError {
  row: number | null
  column: string
  message: string
}

// Database field names → template column names.
const FIELD_COLUMN: Record<string, string> = {
  plan_date: 'Date',
  order_no: 'Order Number',
  job_name: 'Job Name',
  category: 'Category',
  ups: 'UPS',
  job_type: 'Job Type',
  paper_type_id: 'Type of Paper',
  quantity: 'Quantity (Sheets)',
  sides: 'Print Side / Colours',
  colours: 'Colours',
  bs_colours: 'B/S Colours',
  file: 'File',
}
export const columnOf = (field: string) => FIELD_COLUMN[field] ?? field

const NAVY = 'FF102B46'
const TEAL = 'FF078B91'
const MUTED = 'FF687B8D'
const thin = { style: 'thin' as const, color: { argb: 'FFCBD6DF' } }
const box = { top: thin, left: thin, bottom: thin, right: thin }

async function excel(): Promise<typeof import('exceljs')> {
  const mod = await import('exceljs')
  return ((mod as unknown as { default?: typeof import('exceljs') }).default ?? mod) as typeof import('exceljs')
}

function headerCell(ws: Worksheet, row: number, col: number, text: string, fill: string) {
  const c = ws.getCell(row, col)
  c.value = text
  c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
  c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
  c.border = box
  return c
}

// The template: Instructions, Jobs (to fill in), Sample and Lists (dropdown values).
export async function buildTemplate(papers: string[]): Promise<Blob> {
  const ExcelJS = await excel()
  const wb: Workbook = new ExcelJS.Workbook()
  wb.creator = 'Pragati Production Logbook'
  const paperList = papers.length ? papers : ['(add paper types in Master)']

  // Instructions
  const ins = wb.addWorksheet('Instructions', { properties: { tabColor: { argb: TEAL } } })
  ins.columns = [{ width: 22 }, { width: 13 }, { width: 62 }, { width: 26 }]
  ins.getCell('A1').value = 'Pragati Offset · Job Details bulk upload template'
  ins.getCell('A1').font = { bold: true, size: 15, color: { argb: NAVY } }
  const steps = [
    `1. Fill one job per row on the "Jobs" sheet (up to ${MAX_ROWS} rows). Do not rename, move or delete the columns.`,
    '2. Columns marked * are required. Use the dropdowns for Job Type, Type of Paper and Print Side.',
    '3. Save the file and upload it in Production Plan → Job Details → Bulk Upload.',
    '4. The app checks every row first. If any row has a mistake, nothing is imported: fix the rows shown and upload again.',
    '5. Only new Order Numbers can be uploaded; jobs already planned are not changed.',
  ]
  let r = 3
  for (const s of steps) ins.getCell(r++, 1).value = s
  r++
  ;['Column', 'Required', 'What to enter', 'Example'].forEach((h, i) => headerCell(ins, r, i + 1, h, NAVY))
  r++
  for (const c of COLUMNS) {
    const vals = [c.header, c.required ? 'Yes' : 'If F/S + B/S', c.note, c.key === 'paper_type' ? paperList[0] : c.example]
    vals.forEach((v, i) => {
      const cell = ins.getCell(r, i + 1)
      cell.value = v
      cell.border = box
      cell.alignment = { wrapText: true, vertical: 'top' }
      if (i === 1 && c.required) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4E5' } }
    })
    r++
  }
  r++
  ins.getCell(r++, 1).value = 'Print Side rules'
  ins.getCell(r - 1, 1).font = { bold: true, size: 12, color: { argb: NAVY } }
  const rules: [string, string][] = [
    ['O/S', 'One side only. Put its colours in "Colours". Leave "B/S Colours" empty.'],
    ['F/S', 'Front side only. Colours in "Colours".'],
    ['B/S', 'Back side only. Colours in "Colours".'],
    ['F/S + B/S', 'Both sides: F/S colours in "Colours", B/S colours in "B/S Colours" (both required).'],
    ['B/B', 'Plans B/B F and B/B B together with the same colours (same as the app). Colours in "Colours".'],
  ]
  for (const [k, v] of rules) {
    ins.getCell(r, 1).value = k
    ins.getCell(r, 1).font = { bold: true }
    ins.getCell(r, 3).value = v
    ins.getCell(r, 3).alignment = { wrapText: true }
    r++
  }
  r++
  ins.getCell(r++, 1).value = 'Colours'
  ins.getCell(r - 1, 1).font = { bold: true, size: 12, color: { argb: NAVY } }
  for (const s of [
    'Separate colours with commas: C, M, Y, K, PMS 185',
    'Each colour at most 40 characters; the same colour only once per side.',
    'C, M, Y, K are fine to include (they need no ink formula).',
  ]) {
    ins.getCell(r++, 1).value = `• ${s}`
  }
  r++
  ins.getCell(r, 1).value = 'See the "Sample" sheet for three filled-in example jobs.'
  ins.getCell(r, 1).font = { bold: true, color: { argb: TEAL } }

  // Jobs
  const ws = wb.addWorksheet('Jobs', { properties: { tabColor: { argb: NAVY } }, views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }] })
  ws.columns = COLUMNS.map((c) => ({ width: c.width }))
  COLUMNS.forEach((c, i) => {
    const cell = headerCell(ws, 1, i + 1, c.header + (c.required ? ' *' : ''), c.required ? NAVY : TEAL)
    cell.note = c.note
  })
  ws.getRow(1).height = 34
  ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + COLUMNS.length)}1` }
  const last = MAX_ROWS + 1
  const listRef = (col: string, n: number) => [`Lists!$${col}$2:$${col}$${n + 1}`]
  const rules2: Record<string, object> = {
    A: { type: 'date', operator: 'greaterThan', formulae: [new Date(Date.UTC(2020, 0, 1))], error: 'Enter a valid date, e.g. 16-11-2026.', errorTitle: 'Date' },
    B: { type: 'textLength', operator: 'between', formulae: [1, 60], error: '1 to 60 characters.', errorTitle: 'Order Number' },
    C: { type: 'textLength', operator: 'between', formulae: [1, 150], error: '1 to 150 characters.', errorTitle: 'Job Name' },
    D: { type: 'textLength', operator: 'between', formulae: [1, 80], error: '1 to 80 characters.', errorTitle: 'Category' },
    E: { type: 'whole', operator: 'between', formulae: [1, 999999999], error: 'Whole number above 0.', errorTitle: 'UPS' },
    F: { type: 'list', formulae: listRef('A', JOB_TYPES.length), error: 'Choose NPD, NEW or Re-Print from the list.', errorTitle: 'Job Type' },
    G: { type: 'list', formulae: listRef('B', paperList.length), error: 'Choose a paper type from the list (Paper Type master).', errorTitle: 'Type of Paper' },
    H: { type: 'whole', operator: 'between', formulae: [1, 999999999], error: 'Whole number above 0.', errorTitle: 'Quantity' },
    I: { type: 'list', formulae: listRef('C', UPLOAD_SIDES.length), error: 'Choose O/S, F/S, B/S, F/S + B/S or B/B.', errorTitle: 'Print Side' },
  }
  for (let row = 2; row <= last; row++) {
    COLUMNS.forEach((c, i) => {
      const cell = ws.getCell(row, i + 1)
      cell.numFmt = c.key === 'plan_date' ? 'dd-mm-yyyy' : c.key === 'ups' || c.key === 'quantity' ? '0' : '@'
    })
    for (const [col, rule] of Object.entries(rules2)) {
      ws.getCell(`${col}${row}`).dataValidation = { allowBlank: true, showErrorMessage: true, errorStyle: 'stop', ...rule } as never
    }
  }

  // Sample
  const smp = wb.addWorksheet('Sample', { properties: { tabColor: { argb: 'FFF2B84B' } } })
  smp.columns = COLUMNS.map((c) => ({ width: c.width }))
  smp.getCell('A1').value = 'Example jobs for reference only. Type your own jobs on the "Jobs" sheet; this sheet is not imported.'
  smp.getCell('A1').font = { italic: true, color: { argb: MUTED } }
  COLUMNS.forEach((c, i) => headerCell(smp, 2, i + 1, c.header + (c.required ? ' *' : ''), TEAL))
  const p0 = paperList[0]
  const p1 = paperList[paperList.length - 1]
  const samples: (string | number | Date)[][] = [
    [new Date(Date.UTC(2026, 10, 16)), 'PO-2026-0451', 'Sweet Box 500g', 'Carton', 6, 'NEW', p0, 12000, 'F/S + B/S', 'C, M, Y, K, PMS 185', 'K, PMS 286'],
    [new Date(Date.UTC(2026, 10, 16)), 'PO-2026-0452', 'Medicine Mono Carton', 'Pharma', 8, 'Re-Print', p1, 20000, 'O/S', 'C, M, Y, K, Gold, Varnish', ''],
    [new Date(Date.UTC(2026, 10, 17)), 'PO-2026-0453', 'Gift Box Lid', 'Rigid Box', 4, 'NPD', p0, 5000, 'B/B', 'K, PMS 185', ''],
  ]
  samples.forEach((s, n) =>
    s.forEach((v, i) => {
      const cell = smp.getCell(3 + n, i + 1)
      cell.value = v
      cell.border = box
      if (v instanceof Date) cell.numFmt = 'dd-mm-yyyy'
    }),
  )

  // Lists
  const ls = wb.addWorksheet('Lists', { properties: { tabColor: { argb: 'FF9AA9B5' } } })
  ls.columns = [{ width: 18 }, { width: 24 }, { width: 18 }, { width: 4 }, { width: 80 }]
  const lists: [string, readonly string[]][] = [
    ['Job Type', JOB_TYPES],
    ['Type of Paper', paperList],
    ['Print Side', UPLOAD_SIDES],
  ]
  lists.forEach(([h, vals], i) => {
    headerCell(ls, 1, i + 1, h, NAVY)
    vals.forEach((v, j) => (ls.getCell(j + 2, i + 1).value = v))
  })
  ls.getCell('E1').value = 'These lists feed the dropdowns on the Jobs sheet. Please do not edit them: download a new template after adding paper types in the Master.'
  ls.getCell('E1').font = { italic: true, color: { argb: MUTED } }

  wb.views = [{ activeTab: 1, x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, visibility: 'visible' }]
  const buffer = await wb.xlsx.writeBuffer()
  return new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---- Reading an uploaded file ----------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')

function cellText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
  if (typeof value === 'object') {
    const v = value as { richText?: { text: string }[]; text?: string; result?: unknown; error?: string }
    if (v.richText) return v.richText.map((t) => t.text).join('')
    if (v.result !== undefined) return cellText(v.result)
    if (v.text !== undefined) return String(v.text)
    if (v.error) return v.error
  }
  return String(value)
}

// dd-mm-yyyy, dd/mm/yyyy, dd.mm.yyyy or yyyy-mm-dd → yyyy-mm-dd ('' when empty, 'invalid:<text>' when not a date).
export function toIsoDate(value: unknown): string {
  if (value instanceof Date) return cellText(value)
  if (typeof value === 'number') {
    // An Excel serial day number (when the cell was not formatted as a date).
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000)
    return cellText(d)
  }
  const text = cellText(value).trim()
  if (!text) return ''
  let y = 0
  let m = 0
  let d = 0
  const dmy = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/)
  const ymd = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])]
  else if (ymd) [y, m, d] = [Number(ymd[1]), Number(ymd[2]), Number(ymd[3])]
  else return `invalid:${text}`
  const check = new Date(Date.UTC(y, m - 1, d))
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return `invalid:${text}`
  return `${y}-${pad(m)}-${pad(d)}`
}

function numberText(value: unknown): string {
  if (typeof value === 'number') return String(value)
  return cellText(value).trim().replace(/,/g, '')
}

export interface ParsedFile {
  rows: UploadRow[]
  errors: RowError[]
}

// Reads the "Jobs" sheet. Rejects files whose columns don't match the template.
export async function readUpload(file: File): Promise<ParsedFile> {
  const errors: RowError[] = []
  if (!/\.xlsx$/i.test(file.name)) {
    return { rows: [], errors: [{ row: null, column: 'File', message: 'Upload the Excel template (.xlsx file). Download it with "Download Template".' }] }
  }
  if (file.size > 5 * 1024 * 1024) {
    return { rows: [], errors: [{ row: null, column: 'File', message: 'The file is larger than 5 MB. Upload at most 500 jobs per file.' }] }
  }
  const ExcelJS = await excel()
  const wb = new ExcelJS.Workbook()
  try {
    await wb.xlsx.load(await file.arrayBuffer())
  } catch {
    return { rows: [], errors: [{ row: null, column: 'File', message: 'This file could not be read as an Excel file. Save it as .xlsx and try again.' }] }
  }
  const ws = wb.getWorksheet('Jobs')
  if (!ws) {
    return { rows: [], errors: [{ row: null, column: 'File', message: 'The file has no "Jobs" sheet. Use the downloaded template.' }] }
  }
  const header = COLUMNS.map((_, i) => cellText(ws.getCell(1, i + 1).value).replace(/\*/g, '').trim().toLowerCase())
  const wrong = COLUMNS.filter((c, i) => header[i] !== c.header.toLowerCase())
  if (wrong.length) {
    return {
      rows: [],
      errors: [{ row: null, column: 'File', message: `The columns do not match the template (expected ${wrong.map((c) => `"${c.header}"`).join(', ')}). Download the template again and copy your data into it.` }],
    }
  }

  const rows: UploadRow[] = []
  const lastRow = ws.actualRowCount ? ws.rowCount : 0
  for (let r = 2; r <= lastRow; r++) {
    const values = COLUMNS.map((_, i) => ws.getCell(r, i + 1).value)
    if (values.every((v) => cellText(v).trim() === '')) continue
    const get = (key: keyof UploadRow) => values[COLUMNS.findIndex((c) => c.key === key)]
    rows.push({
      row: r,
      plan_date: toIsoDate(get('plan_date')),
      order_no: cellText(get('order_no')).trim(),
      job_name: cellText(get('job_name')).trim(),
      category: cellText(get('category')).trim(),
      ups: numberText(get('ups')),
      job_type: cellText(get('job_type')).trim(),
      paper_type: cellText(get('paper_type')).trim(),
      quantity: numberText(get('quantity')),
      print_side: cellText(get('print_side')).trim(),
      colours: cellText(get('colours')).trim(),
      bs_colours: cellText(get('bs_colours')).trim(),
    })
  }
  if (rows.length === 0) errors.push({ row: null, column: 'File', message: 'The "Jobs" sheet has no jobs. Fill in at least one row.' })
  if (rows.length > MAX_ROWS) errors.push({ row: null, column: 'File', message: `The file has ${rows.length} jobs. Upload at most ${MAX_ROWS} per file.` })

  // Values the database can't even read: report them here, in the user's words.
  for (const row of rows) {
    if (row.plan_date.startsWith('invalid:')) {
      errors.push({ row: row.row, column: 'Date', message: `"${row.plan_date.slice(8)}" is not a valid date (use dd-mm-yyyy).` })
      row.plan_date = 'invalid'
    }
  }
  return { rows, errors }
}

// Sorted by row, then column order.
export function sortErrors(list: RowError[]): RowError[] {
  const order = (c: string) => {
    const i = COLUMNS.findIndex((x) => x.header === c || c.startsWith(x.header))
    return i < 0 ? 99 : i
  }
  return [...list].sort((a, b) => (a.row ?? 0) - (b.row ?? 0) || order(a.column) - order(b.column))
}
