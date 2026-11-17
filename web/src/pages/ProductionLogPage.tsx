import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileDown, FileSpreadsheet, Printer, Search } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { addDays, plantDate } from '../lib/dates'
import { JOB_TYPES, formatDate, formatNumber, searchPattern, tidy } from '../lib/jobs'
import { DOWNTIME_GROUPS, downtimeGroupLabel, entryLabel, formatDuration, formatMoment, isoToStamp, stampToIso } from '../lib/production'
import type { Stamp } from '../lib/production'
import { downloadExcel, downloadPdf, hours, percent } from '../lib/exports'
import type { CellValue, ExportTable } from '../lib/exports'
import { useToast } from '../components/Toast'

const PAGE_SIZE = 25
const MAX_ROWS = 5000

interface LogRow {
  id: string
  entry_no: number
  status: 'draft' | 'submitted'
  production_date: string
  order_no: string | null
  cso_no: string | null
  order_key: string | null
  job_name: string | null
  job_type: string | null
  machine_id: string
  shift: string | null
  print_side: string | null
  ups: number | null
  unit_colours: (string | null)[]
  machine_speed: number | null
  total_sheets: number | null
  ok_sheets: number | null
  separate_sheets: number | null
  wastage_sheets: number
  make_ready_minutes: number | null
  make_ready_net_minutes: number | null
  registration_minutes: number | null
  registration_net_minutes: number | null
  colour_matching_minutes: number | null
  colour_matching_net_minutes: number | null
  changeover_gross_minutes: number | null
  changeover_net_minutes: number | null
  run_minutes: number | null
  run_net_minutes: number | null
  man_minutes: number
  machine_minutes: number
  material_minutes: number
  other_minutes: number
  remarks: string | null
  machines: { code: string } | null
  operators: { name: string } | null
  supervisors: { name: string } | null
  qc_executives: { name: string } | null
  paper_types: { name: string } | null
  coatings: { name: string } | null
}

const COLUMNS =
  'id, entry_no, status, production_date, order_no, cso_no, order_key, job_name, job_type, machine_id, shift, print_side, ups, unit_colours, machine_speed, total_sheets, ok_sheets, separate_sheets, wastage_sheets, make_ready_minutes, make_ready_net_minutes, registration_minutes, registration_net_minutes, colour_matching_minutes, colour_matching_net_minutes, changeover_gross_minutes, changeover_net_minutes, run_minutes, run_net_minutes, man_minutes, machine_minutes, material_minutes, other_minutes, remarks, machines(code), operators(name), supervisors(name), qc_executives(name), paper_types(name), coatings(name)'

interface Named {
  id: string
  name: string
}

interface Filters {
  from: string
  to: string
  machine: string
  shift: string
  operator: string
  supervisor: string
  qc: string
  jobType: string
  paper: string
  coating: string
  status: 'submitted' | 'draft'
}

type GroupBy = 'machine' | 'day' | 'week' | 'month' | 'order' | 'operator' | 'shift' | 'wastage' | 'downtime'
const GROUPS: { key: GroupBy; label: string }[] = [
  { key: 'machine', label: 'Machine-wise' },
  { key: 'day', label: 'Daily' },
  { key: 'week', label: 'Weekly' },
  { key: 'month', label: 'Monthly' },
  { key: 'order', label: 'Production Order-wise' },
  { key: 'operator', label: 'Operator-wise' },
  { key: 'shift', label: 'Shift-wise' },
  { key: 'wastage', label: 'Wastage by reason' },
  { key: 'downtime', label: 'Downtime by reason' },
]

const sum = (rows: LogRow[], pick: (r: LogRow) => number | null | undefined) => rows.reduce((s, r) => s + (pick(r) ?? 0), 0)
const mins = (m: number | null | undefined) => (m == null ? '—' : formatDuration(m))
const downOf = (r: LogRow) => (r.man_minutes ?? 0) + (r.machine_minutes ?? 0) + (r.material_minutes ?? 0) + (r.other_minutes ?? 0)
// Downtime of a set of entries: the total and its split by category
// (Waiting/Approval, Breakdown, Material, Others; stored as man / machine / material / other).
const downtimeSums = (rows: LogRow[]) => ({
  down: sum(rows, downOf),
  man: sum(rows, (r) => r.man_minutes),
  machine: sum(rows, (r) => r.machine_minutes),
  material: sum(rows, (r) => r.material_minutes),
  others: sum(rows, (r) => r.other_minutes),
})
const GROUP_ORDER = DOWNTIME_GROUPS.map((g) => downtimeGroupLabel(g))

// Monday of the week, for weekly grouping.
function weekOf(date: string) {
  const d = new Date(`${date}T00:00:00Z`)
  const back = (d.getUTCDay() + 6) % 7
  return addDays(date, -back)
}

export function ProductionLogPage() {
  const { can, isSuperAdmin } = useAuth()
  const notify = useToast()
  const navigate = useNavigate()
  const today = plantDate()
  const blank: Filters = {
    from: addDays(today, -30),
    to: today,
    machine: '',
    shift: '',
    operator: '',
    supervisor: '',
    qc: '',
    jobType: '',
    paper: '',
    coating: '',
    status: 'submitted',
  }
  const [filters, setFilters] = useState<Filters>(blank)
  const [typed, setTyped] = useState('')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<LogRow[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [page, setPage] = useState(1)
  const [view, setView] = useState<'entries' | 'reports'>('entries')
  const [group, setGroup] = useState<GroupBy>('machine')
  const [extra, setExtra] = useState<{ wastage: { reason: string; qty: number; entries: number }[]; downtime: DowntimeGroup[] }>({
    wastage: [],
    downtime: [],
  })
  const [busy, setBusy] = useState('')
  const [lists, setLists] = useState<Record<string, Named[]>>({})
  const [machines, setMachines] = useState<{ id: string; code: string }[]>([])

  useEffect(() => {
    supabase.from('machines').select('id, code').order('sort_order').order('code').then(({ data }) => setMachines(data ?? []))
    for (const t of ['operators', 'supervisors', 'qc_executives', 'paper_types', 'coatings']) {
      supabase
        .from(t)
        .select('id, name')
        .order('name')
        .then(({ data }) => setLists((l) => ({ ...l, [t]: (data ?? []) as Named[] })))
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setQuery(tidy(typed)), 300)
    return () => clearTimeout(t)
  }, [typed])

  const rangeError = filters.from && filters.to && filters.from > filters.to ? 'From Date cannot be after To Date.' : ''

  useEffect(() => {
    if (rangeError) return
    let alive = true
    let q = supabase
      .from('production_entries')
      .select(COLUMNS)
      .eq('status', filters.status)
      .order('production_date', { ascending: false })
      .order('entry_no', { ascending: false })
      .limit(MAX_ROWS + 1)
    if (filters.from) q = q.gte('production_date', filters.from)
    if (filters.to) q = q.lte('production_date', filters.to)
    if (filters.machine) q = q.eq('machine_id', filters.machine)
    if (filters.shift) q = q.eq('shift', filters.shift)
    if (filters.operator) q = q.eq('operator_id', filters.operator)
    if (filters.supervisor) q = q.eq('supervisor_id', filters.supervisor)
    if (filters.qc) q = q.eq('qc_executive_id', filters.qc)
    if (filters.jobType) q = q.eq('job_type', filters.jobType)
    if (filters.paper) q = q.eq('paper_type_id', filters.paper)
    if (filters.coating) q = q.eq('coating_id', filters.coating)
    if (query) q = q.or(`order_no.ilike.${searchPattern(query)},cso_no.ilike.${searchPattern(query)},job_name.ilike.${searchPattern(query)}`)
    q.then(({ data, error }) => {
      if (!alive) return
      if (error) setLoadError(friendlyError(error))
      else {
        const list = (data ?? []) as unknown as LogRow[]
        setTruncated(list.length > MAX_ROWS)
        setRows(list.slice(0, MAX_ROWS))
        setLoadError('')
      }
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [filters, query, rangeError])

  // Wastage and downtime reasons, only when those reports are open.
  useEffect(() => {
    if (view !== 'reports' || (group !== 'wastage' && group !== 'downtime') || rangeError) return
    let alive = true
    if (group === 'wastage') {
      let q = supabase
        .from('production_entry_wastage')
        .select('entry_id, quantity, wastage_reasons(name), production_entries!inner(production_date, status, machine_id)')
        .eq('production_entries.status', filters.status)
      if (filters.from) q = q.gte('production_entries.production_date', filters.from)
      if (filters.to) q = q.lte('production_entries.production_date', filters.to)
      if (filters.machine) q = q.eq('production_entries.machine_id', filters.machine)
      q.limit(20000).then(({ data, error }) => {
        if (!alive) return
        if (error) return notify('error', friendlyError(error))
        const ids = new Set(rows.map((r) => r.id)) // keep the other filters too
        const map = new Map<string, { reason: string; qty: number; entries: Set<string> }>()
        for (const w of (data ?? []) as unknown as { entry_id: string; quantity: number | null; wastage_reasons: { name: string } | null }[]) {
          if (!ids.has(w.entry_id)) continue
          const reason = w.wastage_reasons?.name ?? 'No reason'
          const g = map.get(reason) ?? { reason, qty: 0, entries: new Set<string>() }
          g.qty += w.quantity ?? 0
          g.entries.add(w.entry_id)
          map.set(reason, g)
        }
        setExtra((x) => ({
          ...x,
          wastage: [...map.values()].map((g) => ({ reason: g.reason, qty: g.qty, entries: g.entries.size })).sort((a, b) => b.qty - a.qty),
        }))
      })
    } else {
      supabase
        .rpc('downtime_counted', { p_from: filters.from || '2000-01-01', p_to: filters.to || today, p_machine_id: filters.machine || null })
        .then(({ data, error }) => {
          if (!alive) return
          if (error) return notify('error', friendlyError(error))
          const map = new Map<string, DowntimeGroup>()
          for (const d of (data ?? []) as { kind: string | null; reason: string | null; entry_id: string | null; minutes: number; counted_minutes: number }[]) {
            const kind = downtimeGroupLabel(d.kind ?? 'Others')
            const key = `${kind}|${d.reason ?? 'No reason'}`
            const g = map.get(key) ?? { kind, reason: d.reason ?? 'No reason', events: 0, inJob: 0, between: 0, minutes: 0, counted: 0 }
            g.events++
            if (d.entry_id) g.inJob++
            else g.between++
            g.minutes += d.minutes
            g.counted += d.counted_minutes
            map.set(key, g)
          }
          setExtra((x) => ({ ...x, downtime: [...map.values()].sort((a, b) => GROUP_ORDER.indexOf(a.kind) - GROUP_ORDER.indexOf(b.kind) || b.counted - a.counted) }))
        })
    }
    return () => {
      alive = false
    }
  }, [view, group, filters, rows, rangeError, today, notify])

  const setFilter = <K extends keyof Filters>(key: K, value: Filters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }

  // ---- Figures ---------------------------------------------------------------------
  const totals = useMemo(() => {
    const given = sum(rows, (r) => r.total_sheets)
    const ok = sum(rows, (r) => r.ok_sheets)
    const waste = sum(rows, (r) => r.wastage_sheets)
    return {
      jobs: new Set(rows.map((r) => r.order_key).filter(Boolean)).size,
      entries: rows.length,
      given,
      ok,
      waste,
      quality: percent(ok, given),
      runGross: sum(rows, (r) => r.run_minutes),
      runNet: sum(rows, (r) => r.run_net_minutes),
      coGross: sum(rows, (r) => r.changeover_gross_minutes),
      coNet: sum(rows, (r) => r.changeover_net_minutes),
      ...downtimeSums(rows),
    }
  }, [rows])

  const grouped = useMemo(() => {
    if (group === 'wastage' || group === 'downtime') return []
    const keyOf = (r: LogRow): [string, string] => {
      switch (group) {
        case 'machine':
          return [r.machine_id, r.machines?.code ?? '']
        case 'day':
          return [r.production_date, formatDate(r.production_date)]
        case 'week':
          return [weekOf(r.production_date), `Week of ${formatDate(weekOf(r.production_date))}`]
        case 'month':
          return [r.production_date.slice(0, 7), formatDate(`${r.production_date.slice(0, 7)}-01`).slice(3)]
        case 'order':
          return [r.order_key ?? '', `${r.order_no ?? ''} · ${r.job_name ?? ''}`]
        case 'operator':
          return [r.operators?.name ?? '', r.operators?.name ?? 'Not entered']
        default:
          return [r.shift ?? '', r.shift ? `Shift ${r.shift}` : 'Not entered']
      }
    }
    const map = new Map<string, { label: string; rows: LogRow[] }>()
    for (const r of rows) {
      const [key, label] = keyOf(r)
      const g = map.get(key) ?? { label, rows: [] }
      g.rows.push(r)
      map.set(key, g)
    }
    const list = [...map.entries()].map(([key, g]) => {
      const given = sum(g.rows, (r) => r.total_sheets)
      const ok = sum(g.rows, (r) => r.ok_sheets)
      const waste = sum(g.rows, (r) => r.wastage_sheets)
      return {
        key,
        label: g.label,
        entries: g.rows.length,
        jobs: new Set(g.rows.map((r) => r.order_key).filter(Boolean)).size,
        given,
        ok,
        waste,
        quality: percent(ok, given),
        wastePct: percent(waste, given),
        coGross: sum(g.rows, (r) => r.changeover_gross_minutes),
        coNet: sum(g.rows, (r) => r.changeover_net_minutes),
        runGross: sum(g.rows, (r) => r.run_minutes),
        runNet: sum(g.rows, (r) => r.run_net_minutes),
        ...downtimeSums(g.rows),
      }
    })
    const dated = group === 'day' || group === 'week' || group === 'month'
    return list.sort((a, b) => (dated ? b.key.localeCompare(a.key) : a.label.localeCompare(b.label)))
  }, [rows, group])

  // ---- Tables for the screen and for downloads ----------------------------------------
  const entryTable = (): ExportTable => ({
    name: 'Production Log',
    headers: [
      'S.No', 'Entry ID', 'Date', 'Production Order Number', 'CSO Number', 'Job Name', 'Machine', 'Shift', 'Operator', 'Supervisor', 'QC Executive',
      'Print Side', 'UPS', 'Paper Type', 'Unit 1', 'Unit 2', 'Unit 3', 'Unit 4', 'Unit 5', 'Unit 6', 'Unit 7', 'Coating',
      'Machine Speed', 'Total Given', 'OK Sheets', 'Separate Sheets', 'Wastage Sheets',
      'Job Changeover (min)', 'Job Changeover net', 'Registration (min)', 'Registration net', 'Colour Matching (min)', 'Colour Matching net',
      'Changeover gross', 'Changeover net', 'Production (min)', 'Production net',
      'Downtime (min)', 'Waiting/Approval (min)', 'Breakdown (min)', 'Material (min)', 'Others (min)', 'Remarks',
    ],
    rows: rows.map((r, i) => [
      i + 1, entryLabel(r.entry_no), formatDate(r.production_date), r.order_no, r.cso_no, r.job_name, r.machines?.code, r.shift,
      r.operators?.name, r.supervisors?.name, r.qc_executives?.name, r.print_side, r.ups, r.paper_types?.name,
      ...Array.from({ length: 7 }, (_, u) => r.unit_colours?.[u] ?? ''), r.coatings?.name,
      r.machine_speed, r.total_sheets, r.ok_sheets, r.separate_sheets, r.wastage_sheets,
      r.make_ready_minutes, r.make_ready_net_minutes, r.registration_minutes, r.registration_net_minutes,
      r.colour_matching_minutes, r.colour_matching_net_minutes, r.changeover_gross_minutes, r.changeover_net_minutes,
      r.run_minutes, r.run_net_minutes, downOf(r), r.man_minutes, r.machine_minutes, r.material_minutes, r.other_minutes, r.remarks,
    ] as CellValue[]),
  })

  const reportTable = (): ExportTable => {
    const label = GROUPS.find((g) => g.key === group)?.label ?? ''
    if (group === 'wastage') {
      const total = extra.wastage.reduce((s, w) => s + w.qty, 0)
      return {
        name: label,
        headers: ['Wastage Reason', 'Entries', 'Wastage Sheets', '% of wastage', '% of given sheets'],
        rows: extra.wastage.map((w) => [w.reason, w.entries, w.qty, percent(w.qty, total), percent(w.qty, totals.given)]),
      }
    }
    if (group === 'downtime') {
      return {
        name: label,
        headers: ['Category', 'Reason', 'Records', 'During jobs', 'Between jobs', 'Recorded (min)', 'Counted (min)', 'Counted (hours)'],
        rows: extra.downtime.map((d) => [d.kind, d.reason, d.events, d.inJob, d.between, d.minutes, d.counted, hours(d.counted)]),
      }
    }
    return {
      name: label,
      headers: [
        label.replace('-wise', ''), 'Entries', 'Jobs', 'Total Given', 'OK Sheets', 'Wastage', 'Quality %', 'Wastage %',
        'Changeover gross (min)', 'Changeover net (min)', 'Production gross (min)', 'Production net (min)',
        'Downtime (min)', 'Waiting/Approval (min)', 'Breakdown (min)', 'Material (min)', 'Others (min)',
      ],
      rows: grouped.map((g) => [
        g.label, g.entries, g.jobs, g.given, g.ok, g.waste, g.quality, g.wastePct, g.coGross, g.coNet, g.runGross, g.runNet,
        g.down, g.man, g.machine, g.material, g.others,
      ]),
    }
  }

  const filterText = () => {
    const parts = [`${formatDate(filters.from) || 'start'} to ${formatDate(filters.to) || 'today'}`, filters.status === 'draft' ? 'Drafts' : 'Submitted entries']
    if (filters.machine) parts.push(`Machine ${machines.find((m) => m.id === filters.machine)?.code}`)
    if (filters.shift) parts.push(`Shift ${filters.shift}`)
    if (query) parts.push(`Search "${query}"`)
    return parts.join(' · ')
  }

  async function exportAs(kind: 'excel' | 'pdf') {
    setBusy(kind)
    try {
      const table = view === 'entries' ? entryTable() : reportTable()
      const name = `Pragati ${view === 'entries' ? 'Production Log' : table.name} ${filters.from}_${filters.to}`.replace(/[^\w .-]/g, '')
      if (kind === 'excel') await downloadExcel(name, [table])
      else await downloadPdf(name, `${view === 'entries' ? 'Production Log Summary' : table.name}`, filterText(), [table])
    } catch (err) {
      notify('error', `Could not create the file: ${(err as Error).message}`)
    } finally {
      setBusy('')
    }
  }

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const visible = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)
  const list = (t: string) => lists[t] ?? []
  const filtersOn = Boolean(typed) || JSON.stringify(filters) !== JSON.stringify(blank)

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Production Log Summary</h1>
          <p className="muted">All production entries in one place · {filterText()}</p>
        </div>
        <div className="actions no-print">
          <button type="button" onClick={() => exportAs('excel')} disabled={!!busy || loading}>
            <FileSpreadsheet size={18} /> {busy === 'excel' ? 'Preparing…' : 'Excel'}
          </button>
          <button type="button" onClick={() => exportAs('pdf')} disabled={!!busy || loading}>
            <FileDown size={18} /> {busy === 'pdf' ? 'Preparing…' : 'PDF'}
          </button>
          <button type="button" onClick={() => window.print()}>
            <Printer size={18} /> Print
          </button>
        </div>
      </div>

      <section className="card no-print">
        <div className="toolbar">
          <label className="search">
            <Search size={18} aria-hidden="true" />
            <input
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value)
                setPage(1)
              }}
              placeholder="Search Production Order, CSO Number or Job Name"
              aria-label="Search"
            />
          </label>
          <label className="inline-field">
            <span>From</span>
            <input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} aria-label="From Date" />
          </label>
          <label className="inline-field">
            <span>To</span>
            <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} aria-label="To Date" />
          </label>
          <select value={filters.status} onChange={(e) => setFilter('status', e.target.value as Filters['status'])} aria-label="Status">
            <option value="submitted">Submitted entries</option>
            <option value="draft">Drafts</option>
          </select>
        </div>
        <div className="toolbar">
          <select value={filters.machine} onChange={(e) => setFilter('machine', e.target.value)} aria-label="Machine">
            <option value="">All machines</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code}
              </option>
            ))}
          </select>
          <select value={filters.shift} onChange={(e) => setFilter('shift', e.target.value)} aria-label="Shift">
            <option value="">All shifts</option>
            <option value="A">Shift A</option>
            <option value="B">Shift B</option>
          </select>
          {(
            [
              ['operator', 'operators', 'All operators'],
              ['supervisor', 'supervisors', 'All supervisors'],
              ['qc', 'qc_executives', 'All QC executives'],
              ['paper', 'paper_types', 'All paper types'],
              ['coating', 'coatings', 'All coatings'],
            ] as const
          ).map(([key, table, all]) => (
            <select key={key} value={filters[key]} onChange={(e) => setFilter(key, e.target.value)} aria-label={all}>
              <option value="">{all}</option>
              {list(table).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          ))}
          <select value={filters.jobType} onChange={(e) => setFilter('jobType', e.target.value)} aria-label="Job type">
            <option value="">All job types</option>
            {JOB_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          {filtersOn && (
            <button
              type="button"
              onClick={() => {
                setFilters(blank)
                setTyped('')
                setQuery('')
                setPage(1)
              }}
            >
              Reset
            </button>
          )}
        </div>
        {(rangeError || loadError) && <p className="notice error">{rangeError || loadError}</p>}
        {truncated && <p className="notice warn">More than {formatNumber(MAX_ROWS)} entries match. Narrow the dates to see them all.</p>}
      </section>

      <div className="metric-grid compact-metrics">
        <Metric label="Total Jobs" value={formatNumber(totals.jobs)} hint={`${formatNumber(totals.entries)} entries`} />
        <Metric label="Total Given Sheets" value={formatNumber(totals.given)} />
        <Metric label="Total OK Sheets" value={formatNumber(totals.ok)} hint={totals.quality === null ? '' : `Quality ${totals.quality}%`} />
        <Metric label="Total Wastage Sheets" value={formatNumber(totals.waste)} hint={totals.given ? `${percent(totals.waste, totals.given)}% of given` : ''} />
        <Metric label="Production Time" value={mins(totals.runNet)} hint={`Net · gross ${mins(totals.runGross)}`} />
        <Metric label="Changeover Time" value={mins(totals.coNet)} hint={`Net · gross ${mins(totals.coGross)}`} />
        <Metric
          label="Downtime (during these jobs)"
          value={mins(totals.down)}
          hint={`Waiting/Approval ${mins(totals.man)} · Breakdown ${mins(totals.machine)} · Material ${mins(totals.material)} · Others ${mins(totals.others)}`}
        />
      </div>

      <div className="section-tabs no-print" role="tablist">
        <button type="button" role="tab" aria-selected={view === 'entries'} className={view === 'entries' ? 'active' : ''} onClick={() => setView('entries')}>
          Entries
        </button>
        <button type="button" role="tab" aria-selected={view === 'reports'} className={view === 'reports' ? 'active' : ''} onClick={() => setView('reports')}>
          Reports
        </button>
      </div>

      {view === 'entries' ? (
        <section className="card">
          <div className="tablewrap">
            <table className="log-table">
              <thead>
                <tr>
                  {[
                    'S.No', 'Entry', 'Date', 'Prod. Order No', 'CSO No', 'Job Name', 'Machine', 'Shift', 'Operator', 'Supervisor', 'QC', 'Side', 'UPS', 'Paper',
                    'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'Coating', 'Speed', 'Given', 'OK', 'Separate', 'Wastage',
                    'Job Changeover', 'Registration', 'Colour Matching', 'Production', 'Downtime', 'Remarks',
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={33} className="empty">
                      Loading…
                    </td>
                  </tr>
                ) : visible.length === 0 ? (
                  <tr>
                    <td colSpan={33} className="empty">
                      No entries for these filters.
                    </td>
                  </tr>
                ) : (
                  visible.map((r, i) => (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/production/entry/${r.id}`)}>
                      <td>{(current - 1) * PAGE_SIZE + i + 1}</td>
                      <td>{entryLabel(r.entry_no)}</td>
                      <td>{formatDate(r.production_date)}</td>
                      <td>
                        <b>{r.order_no}</b>
                      </td>
                      <td>{r.cso_no}</td>
                      <td className="wrap">{r.job_name}</td>
                      <td>{r.machines?.code}</td>
                      <td>{r.shift}</td>
                      <td>{r.operators?.name}</td>
                      <td>{r.supervisors?.name}</td>
                      <td>{r.qc_executives?.name}</td>
                      <td>{r.print_side}</td>
                      <td className="num">{r.ups}</td>
                      <td>{r.paper_types?.name}</td>
                      {Array.from({ length: 7 }, (_, u) => (
                        <td key={u}>{r.unit_colours?.[u] ?? ''}</td>
                      ))}
                      <td>{r.coatings?.name}</td>
                      <td className="num">{formatNumber(r.machine_speed)}</td>
                      <td className="num">{formatNumber(r.total_sheets)}</td>
                      <td className="num">{formatNumber(r.ok_sheets)}</td>
                      <td className="num">{formatNumber(r.separate_sheets)}</td>
                      <td className="num">{formatNumber(r.wastage_sheets)}</td>
                      <td>
                        <GrossNet gross={r.make_ready_minutes} net={r.make_ready_net_minutes} />
                      </td>
                      <td>
                        <GrossNet gross={r.registration_minutes} net={r.registration_net_minutes} />
                      </td>
                      <td>
                        <GrossNet gross={r.colour_matching_minutes} net={r.colour_matching_net_minutes} />
                      </td>
                      <td>
                        <GrossNet gross={r.run_minutes} net={r.run_net_minutes} />
                      </td>
                      <td>
                        <DowntimeSplit row={r} />
                      </td>
                      <td className="wrap">{r.remarks}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="pager no-print">
            <span className="muted small">
              {rows.length ? `Showing ${(current - 1) * PAGE_SIZE + 1}–${Math.min(current * PAGE_SIZE, rows.length)} of ${rows.length}` : 'Showing 0 entries'}
            </span>
            <div className="actions">
              <button type="button" disabled={current <= 1} onClick={() => setPage(current - 1)}>
                Previous
              </button>
              <button type="button" disabled={current >= pages} onClick={() => setPage(current + 1)}>
                Next
              </button>
            </div>
          </div>
          <p className="muted small">Times show net (gross) when downtime happened inside the step. Select a row to open the entry.</p>
        </section>
      ) : (
        <section className="card">
          <div className="toolbar no-print">
            <label className="inline-field">
              <span>Report</span>
              <select value={group} onChange={(e) => setGroup(e.target.value as GroupBy)} aria-label="Report">
                {GROUPS.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {group === 'downtime' && (
            <p className="notice info">
              All downtime of the period (during jobs and between jobs) by type and reason, filtered by date and machine. "Counted" leaves out
              downtime in the overnight window (B-shift end to 8:00 AM).
            </p>
          )}
          <ReportTable table={reportTable()} />
        </section>
      )}

      {view === 'reports' && <ShiftEndCard machines={machines} canEdit={isSuperAdmin || can('production_log', 'edit')} />}
    </>
  )
}

interface DowntimeGroup {
  kind: string
  reason: string
  events: number
  inJob: number
  between: number
  minutes: number
  counted: number
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card metric">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      {hint && <span className="metric-hint">{hint}</span>}
    </div>
  )
}

function DowntimeSplit({ row }: { row: LogRow }) {
  const total = downOf(row)
  if (!total) return null
  const parts = (
    [
      ['Waiting/Approval', row.man_minutes],
      ['Breakdown', row.machine_minutes],
      ['Material', row.material_minutes],
      ['Others', row.other_minutes],
    ] as const
  ).filter(([, m]) => m > 0)
  return (
    <>
      {mins(total)} <span className="muted small">({parts.map(([g, m]) => `${g} ${mins(m)}`).join(', ')})</span>
    </>
  )
}

function GrossNet({ gross, net }: { gross: number | null; net: number | null }) {
  if (gross == null) return null
  if (net == null || net === gross) return <>{mins(gross)}</>
  return (
    <>
      {mins(net)} <span className="muted small">({mins(gross)})</span>
    </>
  )
}

function ReportTable({ table }: { table: ExportTable }) {
  return (
    <div className="tablewrap">
      <table>
        <thead>
          <tr>
            {table.headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.length === 0 ? (
            <tr>
              <td colSpan={table.headers.length} className="empty">
                Nothing to show for these filters.
              </td>
            </tr>
          ) : (
            table.rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => (
                  <td key={j} className={typeof v === 'number' ? 'num' : j === 0 ? 'wrap' : ''}>
                    {typeof v === 'number' ? formatNumber(v) : v}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

// ---- Overnight window: B-shift end per machine and day -------------------------------

interface NightRow {
  machine_id: string
  production_date: string
  starts_at: string
  ends_at: string
  source: string
}

function ShiftEndCard({ machines, canEdit }: { machines: { id: string; code: string }[]; canEdit: boolean }) {
  const notify = useToast()
  const [date, setDate] = useState(addDays(plantDate(), -1))
  const [rows, setRows] = useState<NightRow[]>([])
  const [editing, setEditing] = useState<{ machine: string; end: Stamp; reason: string } | null>(null)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    supabase.rpc('night_windows', { p_from: date, p_to: date }).then(({ data, error: e }) => {
      if (!alive) return
      if (e) setError(friendlyError(e))
      else setRows((data ?? []) as NightRow[])
    })
    return () => {
      alive = false
    }
  }, [date, reload])

  async function save(clear = false) {
    if (!editing) return
    const { data, error: e } = await supabase.rpc('set_shift_end', {
      p_machine_id: editing.machine,
      p_date: date,
      p_end: clear ? null : stampToIso(editing.end),
      p_reason: editing.reason,
    })
    if (e) return setError(friendlyError(e))
    const reply = data as { ok: boolean; message?: string }
    if (!reply.ok) return setError(reply.message ?? 'Could not save.')
    notify('success', clear ? 'B-shift end set back to automatic.' : 'B-shift end saved.')
    setEditing(null)
    setError('')
    setReload((n) => n + 1)
  }

  return (
    <section className="card no-print">
      <h2>Overnight window (B-shift end)</h2>
      <p className="muted small">
        Downtime from the end of B shift until 8:00 AM next morning is not counted in reports. The B-shift end is the last job's
        production end that day (not before 4:30 PM), or 1:00 AM when no job ran.
        {canEdit ? ' You can set it by hand for a machine and day.' : ''}
      </p>
      <div className="toolbar">
        <label className="inline-field">
          <span>Production date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <div className="tablewrap">
        <table className="compact">
          <thead>
            <tr>
              <th>Machine</th>
              <th>B-shift end</th>
              <th>Not counted until</th>
              <th>Based on</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const code = machines.find((m) => m.id === r.machine_id)?.code ?? ''
              const isEditing = editing?.machine === r.machine_id
              return (
                <tr key={r.machine_id}>
                  <td>
                    <b>{code}</b>
                  </td>
                  <td>
                    {isEditing ? (
                      <div className="time-inputs">
                        <input
                          type="date"
                          value={editing.end.date}
                          onChange={(e) => setEditing({ ...editing, end: { ...editing.end, date: e.target.value } })}
                          aria-label="B-shift end date"
                        />
                        <input
                          type="time"
                          value={editing.end.time}
                          onChange={(e) => setEditing({ ...editing, end: { ...editing.end, time: e.target.value } })}
                          aria-label="B-shift end time"
                        />
                      </div>
                    ) : (
                      formatMoment(r.starts_at)
                    )}
                  </td>
                  <td>{formatMoment(r.ends_at)}</td>
                  <td>
                    {isEditing ? (
                      <input
                        value={editing.reason}
                        placeholder="Reason (required)"
                        maxLength={300}
                        onChange={(e) => setEditing({ ...editing, reason: e.target.value })}
                        aria-label="Reason"
                      />
                    ) : (
                      r.source
                    )}
                  </td>
                  <td className="row-actions">
                    {canEdit &&
                      (isEditing ? (
                        <span className="actions">
                          <button type="button" className="small primary" onClick={() => save()}>
                            Save
                          </button>
                          {r.source === 'set by admin' && (
                            <button type="button" className="small" onClick={() => save(true)}>
                              Use automatic
                            </button>
                          )}
                          <button type="button" className="small" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="small"
                          onClick={() => setEditing({ machine: r.machine_id, end: isoToStamp(r.starts_at), reason: '' })}
                        >
                          Change
                        </button>
                      ))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {error && <p className="notice error">{error}</p>}
    </section>
  )
}
