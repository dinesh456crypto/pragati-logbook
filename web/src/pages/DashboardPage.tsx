import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { addDays, plantDate } from '../lib/dates'
import type { Machine } from '../lib/types'
import { formatDate, formatNumber } from '../lib/jobs'

interface RecentJob {
  id: string
  plan_date: string
  order_no: string
  job_name: string
  quantity: number
}

// Dashboard layout with working filters. Figures are filled in as Production Plan
// (phase 3), Production Entry (phase 4) and BDT/ODT (phase 5) come online.
const METRICS: { label: string; hint: string }[] = [
  { label: 'Total Planned Jobs', hint: 'All machines · date range' },
  { label: 'Total Jobs Ran', hint: 'Unique submitted orders' },
  { label: 'Total Changeover Time', hint: 'Machine-level elapsed changeover' },
  { label: 'Total Production Time', hint: 'Submitted production entries' },
  { label: 'Quality', hint: 'OK sheets ÷ total given sheets' },
  { label: 'Total Wastage', hint: 'Wastage sheets' },
  { label: 'Wastage %', hint: 'Wastage sheets ÷ total given sheets' },
  { label: 'Total BDT', hint: 'Breakdown time (plant hours only)' },
  { label: 'Total ODT', hint: 'Other downtime (plant hours only)' },
]

export function DashboardPage() {
  const { can } = useAuth()
  const today = plantDate()
  const [machines, setMachines] = useState<Machine[]>([])
  const [loadError, setLoadError] = useState('')
  const [machine, setMachine] = useState('ALL')
  const [from, setFrom] = useState(addDays(today, -30))
  const [to, setTo] = useState(today)
  const [plannedCount, setPlannedCount] = useState<number | null>(null)
  const [recentJobs, setRecentJobs] = useState<RecentJob[]>([])
  const canSeeJobs = can('production_plan', 'view')

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
      if (counted.error || recent.error) setLoadError((counted.error ?? recent.error)?.message ?? '')
    })
    return () => {
      alive = false
    }
  }, [from, to, rangeError, canSeeJobs])
  const shownMachines = useMemo(
    () => (machine === 'ALL' ? machines : machines.filter((m) => m.id === machine)),
    [machine, machines],
  )

  function reset() {
    setMachine('ALL')
    setFrom(addDays(today, -30))
    setTo(today)
  }

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
        <p className="muted small">Planned jobs count includes all machines.</p>
        {(rangeError || loadError) && <p className="notice error">{rangeError || loadError}</p>}
      </section>

      <p className="notice info">
        Production figures appear here once Production Entry (phase 4) is in use. Drafts are never counted.
      </p>

      <div className="metric-grid">
        {METRICS.map((m) => (
          <div key={m.label} className="card metric">
            <span className="metric-label">{m.label}</span>
            <strong className="metric-value">
              {m.label === 'Total Planned Jobs' && plannedCount !== null && !rangeError ? formatNumber(plannedCount) : '—'}
            </strong>
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
                {['Machine', 'Jobs Ran', 'Changeover', 'Production', 'Quality', 'Wastage', 'BDT', 'ODT'].map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shownMachines.length ? (
                shownMachines.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <b>{m.code}</b>
                      {m.name !== m.code ? ` · ${m.name}` : ''}
                    </td>
                    {Array.from({ length: 7 }, (_, i) => (
                      <td key={i}>—</td>
                    ))}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="empty">
                    No machines available.
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
          <p className="empty">No submitted entries yet.</p>
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
    </>
  )
}
