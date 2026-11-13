import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Eye, Lock, LockOpen, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { friendlyError } from '../lib/errors'
import { formatDate, formatNumber, searchPattern, tidy } from '../lib/jobs'
import { entryLabel, formatDuration, formatMoment } from '../lib/production'
import { ConfirmDialog } from '../components/Modal'
import { useToast } from '../components/Toast'

const PAGE_SIZE = 15

interface ListRow {
  id: string
  entry_no: number
  status: 'draft' | 'submitted'
  production_date: string
  order_no: string | null
  order_key: string | null
  job_name: string | null
  machine_id: string
  shift: string | null
  print_side: string | null
  continuing: boolean
  total_sheets: number | null
  ok_sheets: number | null
  wastage_sheets: number
  run_minutes: number | null
  created_by: string | null
  updated_at: string
  machines: { code: string } | null
  operators: { name: string } | null
}

interface Named {
  id: string
  name: string
}

const COLUMNS =
  'id, entry_no, status, production_date, order_no, order_key, job_name, machine_id, shift, print_side, continuing, total_sheets, ok_sheets, wastage_sheets, run_minutes, created_by, updated_at, machines(code), operators(name)'

type Pending = { kind: 'delete' | 'close' | 'reopen'; row: ListRow } | null

export function ProductionEntriesPage() {
  const { can, profile } = useAuth()
  const notify = useToast()
  const navigate = useNavigate()
  const canCreate = can('production_entry', 'create')
  const canEdit = can('production_entry', 'edit')
  const canDelete = can('production_entry', 'delete')

  const [drafts, setDrafts] = useState<ListRow[]>([])
  const [rows, setRows] = useState<ListRow[]>([])
  const [total, setTotal] = useState(0)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const [page, setPage] = useState(1)
  const [typed, setTyped] = useState('')
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState({ machine: '', shift: '', operator: '', supervisor: '', status: '', from: '', to: '' })
  const [machines, setMachines] = useState<{ id: string; code: string }[]>([])
  const [operators, setOperators] = useState<Named[]>([])
  const [supervisors, setSupervisors] = useState<Named[]>([])
  const [pending, setPending] = useState<Pending>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.from('machines').select('id, code').order('sort_order').order('code').then(({ data }) => setMachines(data ?? []))
    supabase.from('operators').select('id, name').order('name').then(({ data }) => setOperators(data ?? []))
    supabase.from('supervisors').select('id, name').order('name').then(({ data }) => setSupervisors(data ?? []))
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
      .select(COLUMNS, { count: 'exact' })
      .order('production_date', { ascending: false })
      .order('entry_no', { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1)
    if (filters.machine) q = q.eq('machine_id', filters.machine)
    if (filters.shift) q = q.eq('shift', filters.shift)
    if (filters.operator) q = q.eq('operator_id', filters.operator)
    if (filters.supervisor) q = q.eq('supervisor_id', filters.supervisor)
    if (filters.status) q = q.eq('status', filters.status)
    if (filters.from) q = q.gte('production_date', filters.from)
    if (filters.to) q = q.lte('production_date', filters.to)
    if (query) q = q.or(`order_no.ilike.${searchPattern(query)},job_name.ilike.${searchPattern(query)}`)

    Promise.all([
      q,
      supabase.from('production_entries').select(COLUMNS).eq('status', 'draft').order('updated_at', { ascending: false }),
    ]).then(async ([list, draftList]) => {
      if (!alive) return
      if (list.error) {
        setLoadError(friendlyError(list.error))
        setLoading(false)
        return
      }
      const data = (list.data ?? []) as unknown as ListRow[]
      const keys = [...new Set(data.map((r) => r.order_key).filter(Boolean))] as string[]
      const closures = keys.length
        ? await supabase.from('order_side_closures').select('order_key, print_side').in('order_key', keys)
        : { data: [] }
      if (!alive) return
      setClosed(new Set((closures.data ?? []).map((c: { order_key: string; print_side: string }) => `${c.order_key}|${c.print_side}`)))
      setRows(data)
      setTotal(list.count ?? 0)
      setDrafts((draftList.data ?? []) as unknown as ListRow[])
      setLoadError('')
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [page, filters, query, reload, rangeError])

  const refresh = useCallback(() => setReload((n) => n + 1), [])
  const setFilter = (key: keyof typeof filters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }))
    setPage(1)
  }
  const filtersOn = useMemo(() => Boolean(typed) || Object.values(filters).some(Boolean), [typed, filters])
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const isClosed = (r: ListRow) => Boolean(r.order_key && r.print_side && closed.has(`${r.order_key}|${r.print_side}`))
  const mayDelete = (r: ListRow) => canDelete || (r.status === 'draft' && canCreate && r.created_by === profile?.id)
  const mayEdit = (r: ListRow) => (r.status === 'submitted' ? canEdit : canCreate || canEdit)

  async function confirmPending() {
    if (!pending) return
    const { kind, row } = pending
    setBusy(true)
    let error: { code?: string; message?: string } | null = null
    if (kind === 'delete') {
      const res = await supabase.from('production_entries').delete().eq('id', row.id).select('id')
      error = res.error ?? (res.data?.length ? null : { message: 'You do not have permission to delete this entry.' })
    } else {
      const res = await supabase.rpc(kind === 'close' ? 'close_order_side' : 'reopen_order_side', { p_entry_id: row.id })
      error = res.error
    }
    setBusy(false)
    setPending(null)
    if (error) {
      notify(
        'error',
        error.code === '23503'
          ? `${entryLabel(row.entry_no)} is continued by a later entry, so it cannot be deleted. Delete the later entry first.`
          : friendlyError(error, 'entry'),
      )
      return
    }
    notify(
      'success',
      kind === 'delete'
        ? `${row.status === 'draft' ? 'Draft' : 'Entry'} ${entryLabel(row.entry_no)} deleted.`
        : kind === 'close'
          ? `${row.print_side} of order ${row.order_no} closed.`
          : `${row.print_side} of order ${row.order_no} reopened.`,
    )
    refresh()
  }

  const headers = ['S.No', 'Entry ID', 'Date', 'Order No', 'Job Name', 'Machine', 'Shift', 'Side', 'Operator', 'Given', 'OK', 'Wastage', 'Production', 'Status', '']

  return (
    <>
      <div className="pagehead">
        <div>
          <h1>Production Entry</h1>
          <p className="muted">Machine-wise and job-wise production records</p>
        </div>
        {canCreate && (
          <Link to="/production/entry/new" className="button primary">
            <Plus size={18} /> New Entry
          </Link>
        )}
      </div>

      <section className="card">
        <h2>Saved Drafts · resume where you left off</h2>
        {drafts.length === 0 ? (
          <p className="empty">No drafts. A draft appears here after you press Save Draft (one per machine).</p>
        ) : (
          <ul className="recent-list">
            {drafts.map((d) => (
              <li key={d.id}>
                <span>
                  <b>{d.machines?.code}</b> · {entryLabel(d.entry_no)} · {d.order_no || 'Order not entered yet'}
                  <span className="sub">
                    {d.job_name || 'Job details incomplete'} · {formatDate(d.production_date)}
                    {d.shift ? ` · Shift ${d.shift}` : ''} · last saved {formatMoment(d.updated_at)}
                  </span>
                </span>
                <span className="actions">
                  <button type="button" className="small primary" onClick={() => navigate(`/production/entry/${d.id}`)}>
                    {mayEdit(d) ? 'Resume Draft' : 'View'}
                  </button>
                  {mayDelete(d) && (
                    <button type="button" className="small danger-text" onClick={() => setPending({ kind: 'delete', row: d })}>
                      Delete
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="toolbar">
          <label className="search">
            <Search size={18} aria-hidden="true" />
            <input
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value)
                setPage(1)
              }}
              placeholder="Search Order No or Job Name"
              aria-label="Search"
            />
          </label>
          <select value={filters.machine} onChange={(e) => setFilter('machine', e.target.value)} aria-label="Machine filter">
            <option value="">All machines</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.code}
              </option>
            ))}
          </select>
          <select value={filters.shift} onChange={(e) => setFilter('shift', e.target.value)} aria-label="Shift filter">
            <option value="">All shifts</option>
            <option value="A">Shift A</option>
            <option value="B">Shift B</option>
          </select>
          <select value={filters.operator} onChange={(e) => setFilter('operator', e.target.value)} aria-label="Operator filter">
            <option value="">All operators</option>
            {operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <select value={filters.supervisor} onChange={(e) => setFilter('supervisor', e.target.value)} aria-label="Supervisor filter">
            <option value="">All supervisors</option>
            {supervisors.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)} aria-label="Status filter">
            <option value="">All statuses</option>
            <option value="submitted">Submitted</option>
            <option value="draft">Draft</option>
          </select>
          <label className="inline-field">
            <span>From</span>
            <input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} aria-label="From Date" />
          </label>
          <label className="inline-field">
            <span>To</span>
            <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} aria-label="To Date" />
          </label>
          {filtersOn && (
            <button
              type="button"
              onClick={() => {
                setTyped('')
                setQuery('')
                setFilters({ machine: '', shift: '', operator: '', supervisor: '', status: '', from: '', to: '' })
                setPage(1)
              }}
            >
              Clear
            </button>
          )}
        </div>

        {(rangeError || loadError) && <p className="notice error">{rangeError || loadError}</p>}

        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                {headers.map((h) => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={headers.length} className="empty">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={headers.length} className="empty">
                    {filtersOn ? 'No matching entries.' : 'No production entries yet.'}
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => {
                  const sideClosed = isClosed(r)
                  return (
                    <tr key={r.id} className="clickable" onClick={() => navigate(`/production/entry/${r.id}`)}>
                      <td>{(page - 1) * PAGE_SIZE + i + 1}</td>
                      <td>
                        <b>{entryLabel(r.entry_no)}</b>
                      </td>
                      <td>{formatDate(r.production_date)}</td>
                      <td>{r.order_no}</td>
                      <td className="wrap">{r.job_name}</td>
                      <td>{r.machines?.code}</td>
                      <td>{r.shift}</td>
                      <td>
                        {r.print_side}
                        {r.continuing && <span className="muted small"> (cont.)</span>}
                        {sideClosed && <span className="badge grey small-badge">Closed</span>}
                      </td>
                      <td>{r.operators?.name}</td>
                      <td className="num">{formatNumber(r.total_sheets)}</td>
                      <td className="num">{formatNumber(r.ok_sheets)}</td>
                      <td className="num">{formatNumber(r.wastage_sheets)}</td>
                      <td>{formatDuration(r.run_minutes)}</td>
                      <td>
                        <span className={`badge ${r.status === 'submitted' ? 'green' : 'amber'}`}>
                          {r.status === 'submitted' ? 'Submitted' : 'Draft'}
                        </span>
                      </td>
                      <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="icon-button"
                          title={mayEdit(r) ? 'Open / edit' : 'View'}
                          aria-label={`Open ${entryLabel(r.entry_no)}`}
                          onClick={() => navigate(`/production/entry/${r.id}`)}
                        >
                          {mayEdit(r) ? <Pencil size={17} /> : <Eye size={17} />}
                        </button>
                        {r.status === 'submitted' && r.print_side && !sideClosed && (canCreate || canEdit) && (
                          <button
                            type="button"
                            className="icon-button"
                            title={`Close ${r.print_side}`}
                            aria-label={`Close ${r.print_side} of ${r.order_no}`}
                            onClick={() => setPending({ kind: 'close', row: r })}
                          >
                            <Lock size={17} />
                          </button>
                        )}
                        {sideClosed && canEdit && (
                          <button
                            type="button"
                            className="icon-button"
                            title={`Reopen ${r.print_side}`}
                            aria-label={`Reopen ${r.print_side} of ${r.order_no}`}
                            onClick={() => setPending({ kind: 'reopen', row: r })}
                          >
                            <LockOpen size={17} />
                          </button>
                        )}
                        {mayDelete(r) && (
                          <button
                            type="button"
                            className="icon-button danger-text"
                            title="Delete"
                            aria-label={`Delete ${entryLabel(r.entry_no)}`}
                            onClick={() => setPending({ kind: 'delete', row: r })}
                          >
                            <Trash2 size={17} />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <span className="muted small">
            {total
              ? `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total}`
              : 'Showing 0 entries'}
          </span>
          <div className="actions">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        </div>
        <p className="muted small">
          Drafts are not counted in reports. Close a side (lock icon) when it is finished; an order closes when O/S, or both
          sides of its pair, are closed.
        </p>
      </section>

      {pending && (
        <ConfirmDialog
          title={
            pending.kind === 'delete'
              ? `Delete ${pending.row.status === 'draft' ? 'draft' : 'entry'} ${entryLabel(pending.row.entry_no)}?`
              : pending.kind === 'close'
                ? `Close ${pending.row.print_side} of order ${pending.row.order_no}?`
                : `Reopen ${pending.row.print_side} of order ${pending.row.order_no}?`
          }
          message={
            pending.kind === 'delete'
              ? 'It will be removed permanently, with its wastage rows. This cannot be undone.'
              : pending.kind === 'close'
                ? 'No more entries can be added for this side. Close it only when this side of the job is finished.'
                : 'New entries can be added for this side again.'
          }
          confirmLabel={pending.kind === 'delete' ? 'Delete' : pending.kind === 'close' ? 'Close side' : 'Reopen side'}
          danger={pending.kind === 'delete'}
          busy={busy}
          onConfirm={confirmPending}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  )
}
