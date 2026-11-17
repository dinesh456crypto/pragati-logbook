import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { addDays, plantDate } from '../lib/dates'
import type { Machine } from '../lib/types'
import { formatDate, formatNumber } from '../lib/jobs'
import { entryLabel, formatDuration } from '../lib/production'
import { friendlyError } from '../lib/errors'
import { percent } from '../lib/exports'

interface RecentJob {
  id: string
  plan_date: string
  order_no: string
  job_name: string
  quantity: number
}

interface RecentEntry {
  id: string
  entry_no: number
  production_date: string
  order_no: string | null
  job_name: string | null
  shift: string | null
  ok_sheets: number | null
  machines: { code: string } | null
}

interface Figures {
  entries: number
  jobs_ran: number
  given: number
  ok: number
  wastage: number
  changeover_gross: number
  changeover_net: number
  run_gross: number
  run_net: number
  downtime: number
  man: number
  machine: number
  material: number
  others: number
}

interface Dashboard {
  totals: Figures & { night_excluded: number }
  machines: (Figures & { machine_id: string; code: string; name: string })[]
  by_date: { date: string; entries: number; given: number; ok: number; wastage: number; run_gross: number }[]
}

const pct = (part: number, whole: number) => {
  const p = percent(part, whole)
  return p === null ? '—' : `${p}%`
}

export function DashboardPage() {
  const { can } = useAuth()
  const navigate = useNavigate()
  const today = plantDate()
  const [machines, setMachines] = useState<Machine[]>([])
  const [loadError, setLoadError] = useState('')
  const [machine, setMachine] = useState('ALL')
  const [from, setFrom] = useState(addDays(today, -30))
  const [to, setTo] = useState(today)
  const [plannedCount, setPlannedCount] = useState<number | null>(null)
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>([])
  const [recentEntries, setRecentEntries] = useState<RecentEntry[]>([])
  const [figures, setFigures] = useState<Dashboard | null>(null)
  const canSeeJobs = can('production_plan', 'view')
  const canOpenEntries = can('production_entry', 'view')

  useEffect(() => {
    supabase
      .from('machines')
      .select('id, code, name, active, default_speed, sort_order')
      .eq('active', true)
      .order('sort_order')
      .order('code')
      .then(({ data, error }) => {
        if (error) setLoadError(error.message)
        else setMachines((data ?? []) as Machine[])
      })
  }, [])

  const rangeError = from && to && from > to ? 'From Date cannot be after To Date.' : ''
  const machineId = machine === 'ALL' ? null : machine

  // Production figures (submitted entries only; downtime outside the overnight window).
  useEffect(() => {
    if (rangeError || !from || !to) return
    let alive = true
    let recent = supabase
      .from('production_entries')
      .select('id, entry_no, production_date, order_no, job_name, shift, ok_sheets, machines(code)')
      .eq('status', 'submitted')
      .gte('production_date', from)
      .lte('production_date', to)
      .order('production_date', { ascending: false })
      .order('entry_no', { ascending: false })
      .limit(5)
    if (machineId) recent = recent.eq('machine_id', machineId)
    Promise.all([supabase.rpc('dashboard_figures', { p_from: from, p_to: to, p_machine_id: machineId }), recent]).then(([f, r]) => {
      if (!alive) return
      if (f.error) setLoadError(friendlyError(f.error))
      else {
        setFigures(f.data as Dashboard)
        setLoadError('')
      }
      setRecentEntries((r.data ?? []) as unknown as RecentEntry[])
    })
    return () => {
      alive = false
    }
  }, [from, to, machineId, rangeError])

  // Planned jobs in the date range (by plan date). Planned jobs are not tied to a machine.
  useEffect(() => {
    if (rangeError || !canSeeJobs) return
    let alive = true
    const inRange = <T extends { gte: (c: string, v: string) => T; lte: (c: string, v: string) => T }>(q: T) => {
      let r = q
      if (from) r = r.gte('plan_date', from)
      if (to) r = r.lte('plan_date', to)
      return r
    }
    Promise.all([
      inRange(supabase.from('production_jobs').select('id', { count: 'exact', head: true })),
      inRange(
        supabase
          .from('production_jobs')
          .select('id, plan_date, order_no, job_name, quantity')
          .order('plan_date', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(5),
      ),
    ]).then(([counted, recent]) => {
      if (!alive) return
      setPlannedCount(counted.error ? null : (counted.count ?? 0))
      setRecentJobs(recent.error ? [] : ((recent.data ?? []) as RecentJob[]))
    })
    return () => {
      alive = false
    }
  }, [from, to, rangeError, canSeeJobs])

  function reset() {
    setMachine('ALL')
    setFrom(addDays(today, -30))
    setTo(today)
  }

  const t = figures?.totals
  const metrics: { label: string; value: string; hint: string }[] = [
    { label: 'Total Planned Jobs', value: plannedCount === null ? '—' : formatNumber(plannedCount), hint: 'All machines · by plan date' },
    { label: 'Total Jobs Ran', value: t ? formatNumber(t.jobs_ran) : '—', hint: t ? `${formatNumber(t.entries)} submitted entries` : 'Unique orders' },
    {
      label: 'Total Changeover Time',
      value: t ? formatDuration(t.changeover_net) : '—',
      hint: t ? `Net · gross ${formatDuration(t.changeover_gross)}` : 'Job Changeover + Registration + Colour Matching',
    },
    {
      label: 'Total Production Time',
      value: t ? formatDuration(t.run_net) : '—',
      hint: t ? `Net · gross ${formatDuration(t.run_gross)}` : 'Submitted entries',
    },
    { label: 'Quality', value: t ? pct(t.ok, t.given) : '—', hint: 'OK sheets ÷ total given sheets' },
    { label: 'Total Wastage', value: t ? formatNumber(t.wastage) : '—', hint: 'Wastage sheets' },
    { label: 'Wastage %', value: t ? pct(t.wastage, t.given) : '—', hint: 'Wastage sheets ÷ total given sheets' },
    {
      label: 'Total Downtime',
      value: t ? formatDuration(t.downtime) : '—',
      hint: t
        ? `Waiting/Approval ${formatDuration(t.man)} · Breakdown ${formatDuration(t.machine)} · Material ${formatDuration(t.material)} · Others ${formatDuration(t.others)}${t.night_excluded ? ` · ${formatDuration(t.night_excluded)} overnight not counted` : ''}`
        : 'Overnight window left out',
    },
  ]

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Dashboard</h1>
          <p className="muted">Machine-wise production performance and planned-job overview</p>
        </div>
        <div className="actions">
          {can('production_entry', 'create') && (
            <Link to="/production/entry/new" className="button primary">
              <Plus size={18} /> New Production Entry
            </Link>
          )}
          {can('production_plan', 'create') && (
            <Link to="/plan/jobs?new=1" className="button teal">
              <Plus size={18} /> New Job
            </Link>
          )}
        </div>
      </div>

      <section className="card filters">
        <label className="field">
          <span>Machine</span>
          <select value={machine} onChange={(e) => setMachine(e.target.value)}>
            <option value="ALL">All Machines</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>From Date</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span>To Date</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button type="button" onClick={reset}>
          Reset Filters
        </button>
        <p className="muted small">Planned jobs count includes all machines. Drafts are never counted.</p>
        {(rangeError || loadError) && <p className="notice error">{rangeError || loadError}</p>}
      </section>

      <div className="metric-grid">
        {metrics.map((m) => (
          <div key={m.label} className="card metric">
            <span className="metric-label">{m.label}</span>
            <strong className="metric-value">{m.value}</strong>
            <span className="metric-hint">{m.hint}</span>
          </div>
        ))}
      </div>

      <section className="card">
        <h2>Machine-wise Production Summary</h2>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                {['Machine', 'Jobs Ran', 'Changeover (net)', 'Production (net)', 'Given', 'OK', 'Quality', 'Wastage', 'Wastage %', 'Downtime', 'Waiting/Approval', 'Breakdown', 'Material', 'Others'].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {figures?.machines.length ? (
                figures.machines.map((m) => (
                  <tr key={m.machine_id}>
                    <td>
                      <b>{m.code}</b>
                      {m.name !== m.code ? ` · ${m.name}` : ''}
                    </td>
                    <td className="num">{formatNumber(m.jobs_ran)}</td>
                    <td>{formatDuration(m.changeover_net)}</td>
                    <td>{formatDuration(m.run_net)}</td>
                    <td className="num">{formatNumber(m.given)}</td>
                    <td className="num">{formatNumber(m.ok)}</td>
                    <td className="num">{pct(m.ok, m.given)}</td>
                    <td className="num">{formatNumber(m.wastage)}</td>
                    <td className="num">{pct(m.wastage, m.given)}</td>
                    <td>
                      <b>{formatDuration(m.downtime)}</b>
                    </td>
                    <td>{formatDuration(m.man)}</td>
                    <td>{formatDuration(m.machine)}</td>
                    <td>{formatDuration(m.material)}</td>
                    <td>{formatDuration(m.others)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={14} className="empty">
                    {figures ? 'No machines available.' : 'Loading…'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="two-col">
        <section className="card">
          <h2>Recent Production Entries</h2>
          {recentEntries.length === 0 ? (
            <p className="empty">No submitted entries in this date range.</p>
          ) : (
            <ul className="recent-list">
              {recentEntries.map((e) => (
                <li
                  key={e.id}
                  className={canOpenEntries ? 'clickable' : ''}
                  onClick={() => canOpenEntries && navigate(`/production/entry/${e.id}`)}
                >
                  <span>
                    <b>{e.order_no}</b> · {e.machines?.code}
                    <span className="sub">
                      {entryLabel(e.entry_no)} · {e.job_name}
                    </span>
                  </span>
                  <span className="muted small" style={{ textAlign: 'right' }}>
                    {formatDate(e.production_date)} · Shift {e.shift}
                    <span className="sub">{formatNumber(e.ok_sheets)} OK sheets</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {can('production_log', 'view') && (
            <Link to="/production/log" className="small">
              Open Production Log Summary →
            </Link>
          )}
        </section>
        <section className="card">
          <h2>Recently Planned Jobs</h2>
          {!canSeeJobs ? (
            <p className="empty">You do not have access to Production Plan.</p>
          ) : recentJobs.length === 0 ? (
            <p className="empty">No jobs planned in this date range.</p>
          ) : (
            <ul className="recent-list">
              {recentJobs.map((j) => (
                <li key={j.id}>
                  <span>
                    <b>{j.order_no}</b>
                    <span className="sub">{j.job_name}</span>
                  </span>
                  <span className="muted small" style={{ textAlign: 'right' }}>
                    {formatDate(j.plan_date)}
                    <span className="sub">{formatNumber(j.quantity)} sheets</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canSeeJobs && (
            <Link to="/plan/jobs" className="small">
              View all jobs →
            </Link>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Production by Date</h2>
        <div className="tablewrap">
          <table className="compact">
            <thead>
              <tr>
                {['Date', 'Entries', 'Given', 'OK', 'Quality', 'Wastage', 'Production'].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {figures?.by_date.length ? (
                figures.by_date.map((d) => (
                  <tr key={d.date}>
                    <td>{formatDate(d.date)}</td>
                    <td className="num">{d.entries}</td>
                    <td className="num">{formatNumber(d.given)}</td>
                    <td className="num">{formatNumber(d.ok)}</td>
                    <td className="num">{pct(d.ok, d.given)}</td>
                    <td className="num">{formatNumber(d.wastage)}</td>
                    <td>{formatDuration(d.run_gross)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={7} className="empty">
                    No submitted entries in this date range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}
